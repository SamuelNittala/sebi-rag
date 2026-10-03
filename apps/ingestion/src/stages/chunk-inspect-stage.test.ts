import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ArtifactDescriptor } from "@mf-rag/types";
import type { StageInspectionReviewInput } from "@mf-rag/db";

import type { DoclingParseResponse } from "../parsers/docling-contract.ts";
import { minimalDoclingResponse } from "../parsers/docling-test-fixture.ts";
import {
  ChunkInspectStage,
  preparePdfChunkInspection,
  type ChunkInspectionReviewRepository,
} from "./chunk-inspect-stage.ts";
import {
  DoclingParseStage,
  doclingPdfMediaType,
  type DoclingPdfParseArtifact,
} from "./docling-parse-stage.ts";
import type { NormalizedPdfParseArtifact, PdfStageArtifactStore } from "./parse-pdf-stage.ts";

const FIXTURE_DIR = new URL("../../../../tests/fixtures/docling/", import.meta.url);
const GOLDEN_PDF = new URL("mirae-flexi-cap-p34-35.pdf", FIXTURE_DIR);
const GOLDEN_WIRE = new URL("mirae-flexi-cap-p34-35.wire.json", FIXTURE_DIR);
const goldenExists = await Bun.file(GOLDEN_WIRE).exists();

const ownership = {
  visibilityScope: "TENANT" as const,
  tenantId: "117",
  ownershipManifestId: "source-registry:revision-1",
  ownershipManifestVersion: 1,
};
const knowledgeScope = {
  knowledgeDomain: "mutual_fund" as const,
  sourceCollection: "mirae_mf" as const,
  amcSlug: "mirae-asset",
};

class MemoryArtifactStore implements PdfStageArtifactStore {
  readonly stored = new Map<string, Uint8Array>();

  constructor(private readonly raw: Uint8Array) {}

  async readVerified(descriptor: ArtifactDescriptor): Promise<Uint8Array> {
    return this.stored.get(descriptor.sha256) ?? this.raw;
  }

  async put(input: Parameters<PdfStageArtifactStore["put"]>[0]): Promise<ArtifactDescriptor> {
    this.stored.set(input.sha256, input.bytes);
    return {
      key: `${input.namespace}/${input.sha256}`,
      uri: `memory://${input.sha256}`,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mediaType: input.mediaType,
      producerVersion: input.producerVersion,
    };
  }
}

class RecordingReviewRepository implements ChunkInspectionReviewRepository {
  readonly inputs: Array<StageInspectionReviewInput & {
    documentVersionId: string;
    configRevisionId: string;
    pipelineRunId: string;
  }> = [];

  async stage(input: RecordingReviewRepository["inputs"][number]): Promise<{ id: string }> {
    this.inputs.push(input);
    return { id: `review-${this.inputs.length}` };
  }
}

/** Runs the real Docling parse stage on a canned response to get a stored artifact. */
async function doclingArtifact(
  rawBytes: Uint8Array,
  response: (source: { sha256: string; byteSize: number }) => DoclingParseResponse,
  filename = "Mirae-Asset-Factsheet-August-2026.pdf",
) {
  const sha256 = createHash("sha256").update(rawBytes).digest("hex");
  const store = new MemoryArtifactStore(rawBytes);
  const body = response({ sha256, byteSize: rawBytes.byteLength });
  const stage = new DoclingParseStage({ artifactStore: store, parse: async () => body }, {
    serviceUrl: "http://docling:8090",
    parserVersion: body.producer.parserVersion,
    producerVersion: `parse-artifact-v1+${body.producer.parserVersion}`,
  });
  const { artifact, parsed } = await stage.execute({
    documentVersionId: "version-1",
    rawArtifact: {
      key: "raw/fixture",
      uri: "memory://raw",
      sha256,
      byteSize: rawBytes.byteLength,
      mediaType: "application/pdf",
      producerVersion: "fetch-v1",
    },
    filename,
    canonicalUrl: "https://www.miraeassetmf.co.in/docs/factsheet.pdf",
  });
  return { artifact, parsed, store };
}

function stageInput(artifact: ArtifactDescriptor) {
  return {
    documentVersionId: "version-1",
    pipelineRunId: "pipeline-run-1",
    sourceDocumentId: "source-document-1",
    accessScopeId: "scope-117",
    parsedArtifact: artifact,
    expectedParsedChecksum: artifact.sha256,
    trustedContext: {
      accessScopeId: "scope-117",
      accessScopeKey: "mirae-mf",
      externalCode: "117",
      configRevisionId: "revision-1",
      configRevisionChecksum: "b".repeat(64),
      classification: knowledgeScope,
    },
  };
}

const rawBytes = new TextEncoder().encode("%PDF-1.7\ndocling chunk stage fixture");

describe("ChunkInspectStage with Docling artifacts", () => {
  test("stages Docling candidates with the Docling chunker and parser identity", async () => {
    const { artifact, parsed, store } = await doclingArtifact(rawBytes, minimalDoclingResponse);
    const repository = new RecordingReviewRepository();
    const result = await new ChunkInspectStage({ artifactStore: store, reviewRepository: repository })
      .execute(stageInput(artifact));

    expect(artifact.mediaType).toBe(doclingPdfMediaType());
    expect(result.candidateCount).toBe(2);
    const staged = repository.inputs[0]!;
    expect(staged.chunkerVersion).toBe("docling-hybrid-v1");
    expect(staged.parserVersion).toBe(`${parsed.parser.parserVersion}+docling-tableformer-accurate+norm-1`);
    expect(staged.parserVersion.startsWith("unpdf")).toBe(false);
    expect(staged.report.inspectedChunkCount).toBe(2);
    expect(staged.candidates.every((candidate) => candidate.metadata.parser === "docling")).toBe(true);
    expect(staged.candidates[0]!.metadata.fundName).toBe("Mirae Asset Flexi Cap Fund");
    expect(staged.candidates[0]!.text).toStartWith("MIRAE ASSET FLEXI CAP FUND\nFund Details\n");
    expect(staged.candidates[0]!.metadata.parserDiagnostics).toEqual({ lowStructurePages: [2], uncoveredPages: [] });
  });

  test("rejects an unknown parsed media type before reading the artifact", async () => {
    const { artifact, store } = await doclingArtifact(rawBytes, minimalDoclingResponse);
    const repository = new RecordingReviewRepository();
    const stage = new ChunkInspectStage({ artifactStore: store, reviewRepository: repository });

    await expect(stage.execute(stageInput({ ...artifact, mediaType: "application/json" })))
      .rejects.toMatchObject({ code: "INVALID_PARSED_MEDIA_TYPE", classification: "deterministic" });
    expect(repository.inputs).toHaveLength(0);
  });

  test("routes a Docling document detected as an addendum through the addendum chunker", async () => {
    const { parsed } = await doclingArtifact(rawBytes, (source) => {
      const body = structuredClone(minimalDoclingResponse(source)) as any;
      body.pages[0].text = [
        "NOTICE CUM ADDENDUM NO. SIF/05/2026",
        "NOTICE-CUM-ADDENDUM TO THE SAI, ISID AND KIM OF PLATINUM HYBRID LONG-SHORT FUND",
        "The features shall stand modified with effect from Wednesday, July 01, 2026.",
        "Particulars Existing Provisions Proposed Provisions",
        "Minimum Application Amount/switch in",
        "Minimum amount for accredited investor: Rs. 5,00,000 and in multiples of Re. 1,000 thereafter.",
        "Minimum amount for accredited investor: Rs. 1,00,000 and in multiples of Re. 1,000 thereafter.",
        "• Systematic Investment Plan",
        "Monthly and Quarterly Systematic Investment Plan with a minimum amount of Rs. 50,000 and minimum of 5 instalments.",
        "• Systematic Withdrawal Plan",
        "Investors can withdraw for a minimum of Rs. 50,000 and in multiples of Re. 1 thereafter.",
        "• Systematic Investment Plan",
        "Monthly and Quarterly Systematic Investment Plan with a minimum amount of Rs. 5,000 and in multiples of Re. 1 thereafter,",
        "with a minimum of 5 instalments. The minimum investment should be Rs. 10,00,000 across all strategies and for",
        "accredited investor it should be at least Rs. 1,00,000 in Platinum Hybrid Long-Short Fund.",
      ].join("\n");
      body.pages[1].text = [
        "The existing SWP minimum balance for accredited investor should be at least Rs. 5,00,000 in the fund.",
        "• Systematic Withdrawal Plan",
        "Investors can withdraw for a minimum of Rs. 5,000 and in multiples of Re. 1 thereafter.",
        "For SWP, the minimum investment after withdrawal should be Rs. 10,00,000 across all strategies and for",
        "accredited investor it should be at least Rs. 1,00,000 in Platinum Hybrid Long-Short Fund.",
        "Exit Load: If redeemed within 90 days from the date of allotment: 1%. If redeemed after 90 days: NIL.",
        "Exit Load: If redeemed within 30 days from the date of allotment: 1%. If redeemed after 30 days: NIL.",
        "This Notice-cum-Addendum forms an integral part of the ISID, KIM and SAI.",
        "All other terms and conditions remain unchanged.",
        "DATE: June 29, 2026",
      ].join("\n");
      return body;
    }, "addendum-sif-05-2026.pdf");

    const inspection = preparePdfChunkInspection({
      parsed,
      sourceDocumentId: "source-document-1",
      ownership,
      knowledgeScope,
      metadata: {
        fundName: "Platinum Hybrid Long-Short Fund",
        docType: "Addendum",
        documentDate: new Date("2026-06-29T00:00:00.000Z"),
        effectiveDate: new Date("2026-07-01T00:00:00.000Z"),
        amendmentNumber: "SIF/05/2026",
        amendedDocumentTypes: ["SAI", "ISID", "KIM"],
        amcName: "Mirae Asset Mutual Fund",
        schemeType: "Other",
        schemeCategory: null,
        isinGrowth: null,
        isinDividend: null,
        schemeCode: null,
      },
    });

    expect(inspection.chunkerVersion).toBe("addendum-v1");
    expect(inspection.prepared.candidates.some((candidate) => candidate.metadata.parser === "docling")).toBe(false);
    expect(inspection.prepared.candidates[0]!.metadata).not.toHaveProperty("parserDiagnostics");
  });

  test("strips NUL characters from Docling chunk text and headings", async () => {
    const { parsed } = await doclingArtifact(rawBytes, minimalDoclingResponse);
    const withNul: DoclingPdfParseArtifact = {
      ...parsed,
      chunks: parsed.chunks.map((chunk) => ({
        ...chunk,
        text: `${chunk.text}\u0000`,
        headings: chunk.headings.map((heading) => `${heading}\u0000`),
      })),
    };

    const inspection = preparePdfChunkInspection({
      parsed: withNul,
      sourceDocumentId: "source-document-1",
      ownership,
      knowledgeScope,
    });

    expect(inspection.prepared.candidates.every((candidate) =>
      !candidate.text.includes("\u0000")
      && !(candidate.sectionHeader ?? "").includes("\u0000")
    )).toBe(true);
  });

  test.skipIf(!goldenExists)("prepares golden Flexi Cap candidates as a factsheet", async () => {
    const pdf = new Uint8Array(await Bun.file(GOLDEN_PDF).arrayBuffer());
    const wire = await Bun.file(GOLDEN_WIRE).json() as DoclingParseResponse;
    const { parsed } = await doclingArtifact(pdf, () => wire);

    const inspection = preparePdfChunkInspection({
      parsed,
      sourceDocumentId: "source-document-1",
      ownership,
      knowledgeScope,
    });
    const { candidates, report } = inspection.prepared;

    expect(inspection.chunkerVersion).toBe("docling-hybrid-v1");
    expect(inspection.metadata.docType).toBe("Factsheet");
    // Dates come from `DATE:` lines or the filename; ordinal-joined text such as
    // "31st August 2026" must not change the extracted document date.
    expect(candidates[0]!.metadata.documentDate).toBe("2026-08-01");
    expect(candidates).toHaveLength(wire.chunks.length);
    for (const candidate of candidates) {
      expect(candidate.metadata.fundName).toBe("Mirae Asset Flexi Cap Fund");
      expect(candidate.text.toLowerCase()).toContain("mirae asset flexi cap fund");
    }
    const rules = report.findings.map((finding) => finding.ruleCode);
    expect(rules).not.toContain("TABLE_SPAN_DUPLICATION");
    expect(rules).not.toContain("LOW_STRUCTURE_PAGE");
    expect(report.findings.filter((finding) => finding.ruleCode === "CHART_VALUES_UNBOUND")
      .map((finding) => finding.chunkIndex)).toEqual(
      wire.chunks.filter((chunk) =>
        chunk.flags.includes("chart_multi_series_unparsed") || chunk.flags.includes("chart_unpaired"))
        .map((chunk) => chunk.chunkIndex),
    );
  });
});

describe("source document type override", () => {
  const addendumReference = "Pursuant to notice cum addendum no. 70/2026, the expense ratio stands revised.";
  const factsheetFilename = "mirae-flexi-cap-p34-35.pdf";

  async function factsheetDoclingArtifact() {
    return doclingArtifact(rawBytes, (source) => {
      const body = structuredClone(minimalDoclingResponse(source)) as any;
      body.pages[0].text = `${body.pages[0].text}\n${addendumReference}`;
      return body;
    }, factsheetFilename);
  }

  function factsheetUnpdfArtifact(): NormalizedPdfParseArtifact {
    const text = [
      "Mirae Asset Flexi Cap Fund",
      "Fund Details",
      "The investment objective of the scheme is to generate long term capital appreciation.",
      addendumReference,
    ].join("\n");
    return {
      schemaVersion: 1,
      documentVersionId: "version-1",
      source: {
        filename: factsheetFilename,
        canonicalUrl: "https://www.miraeassetmf.co.in/docs/factsheet.pdf",
        rawSha256: "c".repeat(64),
        rawByteSize: 10,
      },
      parser: { parserVersion: "unpdf-test", tableExtractorVersion: "pdfplumber-test" },
      pages: [{ pageNumber: 1, text, hasTable: false }],
      tables: [],
      diagnostics: {
        pageCount: 1,
        emptyPageCount: 0,
        tableCount: 0,
        tableExtractionStatus: "succeeded",
        tableExtractionCode: null,
      },
    };
  }

  test("without an override a factsheet citing an addendum is classified as Addendum (baseline)", async () => {
    const { parsed } = await factsheetDoclingArtifact();

    const docling = preparePdfChunkInspection({ parsed, sourceDocumentId: "source-document-1", ownership, knowledgeScope });
    const unpdf = preparePdfChunkInspection({
      parsed: factsheetUnpdfArtifact(), sourceDocumentId: "source-document-1", ownership, knowledgeScope,
    });

    expect(docling.metadata.docType).toBe("Addendum");
    expect(unpdf.metadata.docType).toBe("Addendum");
    expect(unpdf.chunkerVersion).toBe("semantic-addendum-fallback-v1");
  });

  test("the Docling path honours the source document type and keeps Docling chunks", async () => {
    const { parsed } = await factsheetDoclingArtifact();

    const inspection = preparePdfChunkInspection({
      parsed, sourceDocumentId: "source-document-1", ownership, knowledgeScope, documentType: "Factsheet",
    });

    expect(inspection.metadata.docType).toBe("Factsheet");
    expect(inspection.chunkerVersion).toBe("docling-hybrid-v1");
    expect(inspection.prepared.candidates.every((candidate) =>
      candidate.metadata.parser === "docling"
      && candidate.metadata.documentType === "Factsheet"
      && candidate.metadata.addendumChunkingMode === null)).toBe(true);
    expect(inspection.prepared.report.findings.map((finding) => finding.ruleCode))
      .not.toContain("ADDENDUM_METADATA_INCOMPLETE");
  });

  test("the unpdf path honours the source document type", () => {
    const inspection = preparePdfChunkInspection({
      parsed: factsheetUnpdfArtifact(), sourceDocumentId: "source-document-1", ownership, knowledgeScope,
      documentType: "Factsheet",
    });

    expect(inspection.metadata.docType).toBe("Factsheet");
    expect(inspection.chunkerVersion).toBe("semantic-v1");
    expect(inspection.prepared.report.findings.map((finding) => finding.ruleCode))
      .not.toContain("ADDENDUM_METADATA_INCOMPLETE");
  });

  test("ChunkInspectStage passes its input document type into metadata extraction", async () => {
    const { artifact, store } = await factsheetDoclingArtifact();
    const stageWith = async (documentType?: "Factsheet") => {
      const repository = new RecordingReviewRepository();
      await new ChunkInspectStage({ artifactStore: store, reviewRepository: repository })
        .execute({ ...stageInput(artifact), ...(documentType ? { documentType } : {}) });
      return repository.inputs[0]!;
    };

    const overridden = await stageWith("Factsheet");
    const heuristic = await stageWith();

    expect(overridden.chunkerVersion).toBe("docling-hybrid-v1");
    expect(overridden.candidates.every((candidate) => candidate.metadata.documentType === "Factsheet")).toBe(true);
    expect(heuristic.candidates.every((candidate) => candidate.metadata.documentType === "Addendum")).toBe(true);
  });
});

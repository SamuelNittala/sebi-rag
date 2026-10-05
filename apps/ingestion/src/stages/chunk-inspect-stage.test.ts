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


describe("document-level metadata does not leak onto multi-fund factsheet chunks", () => {
  /**
   * A multi-fund Docling factsheet: the cover advertises one fund, later pages cover other funds,
   * and some chunks (fund-facts/offerings pages) name no fund of their own. Mirrors the passive
   * factsheet where every chunk inherited the cover fund, strategy and scheme category.
   */
  function multiFundResponse(source: { sha256: string; byteSize: number }): DoclingParseResponse {
    const body = structuredClone(minimalDoclingResponse(source)) as any;
    body.pageCount = 3;
    body.pages = [
      { pageNumber: 1, width: 595, height: 842, text: "Mirae Asset Multi Factor Passive FOF\nMid Cap", hasTable: false,
        stats: { textItems: 2, tables: 0, pictures: 0, pictureTextChars: 0, bodyTextChars: 80 } },
      { pageNumber: 2, width: 595, height: 842, text: "MIRAE ASSET FLEXI CAP FUND", hasTable: false,
        stats: { textItems: 1, tables: 0, pictures: 0, pictureTextChars: 0, bodyTextChars: 80 } },
      { pageNumber: 3, width: 595, height: 842, text: "Our Passive Fund Offerings", hasTable: false,
        stats: { textItems: 1, tables: 0, pictures: 0, pictureTextChars: 0, bodyTextChars: 80 } },
    ];
    body.chunks = [
      // Cover advert fund (the document's "first fund").
      { chunkIndex: 0, type: "text", text: "An index fund of funds.",
        headings: ["Mirae Asset Multi Factor Passive FOF"], pages: [1],
        bboxes: [{ page: 1, l: 10, t: 100, r: 100, b: 10 }], itemRefs: ["#/texts/0"], flags: [], picture: null },
      // A different fund on a later page.
      { chunkIndex: 1, type: "text", text: "An open ended dynamic equity scheme.",
        headings: ["MIRAE ASSET FLEXI CAP FUND"], pages: [2],
        bboxes: [{ page: 2, l: 10, t: 100, r: 100, b: 10 }], itemRefs: ["#/texts/1"], flags: [], picture: null },
      // A multi-fund offerings page: no scheme of its own.
      { chunkIndex: 2, type: "text", text: "- Mirae Asset Nifty 50 ETF\n- Mirae Asset Nifty Bank ETF",
        headings: ["Our Passive Fund Offerings"], pages: [3],
        bboxes: [{ page: 3, l: 10, t: 100, r: 100, b: 10 }], itemRefs: ["#/texts/2"], flags: [], picture: null },
    ];
    body.diagnostics = {
      droppedPictures: { logo: 0, signature: 0, stamp: 0, qrCode: 0, barCode: 0, noText: 0 },
      flagCounts: {}, conversionStatus: "success", conversionMs: 10,
    };
    return body;
  }

  const factsheetName = "Mirae-Asset-Passive-Factsheet-August-2026.pdf";

  test("a chunk without its own fund never inherits the document's cover fund, strategy or category", async () => {
    const { parsed } = await doclingArtifact(rawBytes, multiFundResponse, factsheetName);
    const inspection = preparePdfChunkInspection({
      parsed, sourceDocumentId: "source-document-1", ownership, knowledgeScope, documentType: "Factsheet",
    });
    const [cover, flexi, offerings] = inspection.prepared.candidates;

    // The offerings chunk names no fund: nothing document-level reaches it.
    expect(offerings!.metadata.fundName ?? null).toBeNull();
    expect(offerings!.metadata.strategyId ?? null).toBeNull();
    expect(offerings!.metadata.canonicalStrategyName ?? null).toBeNull();
    expect(offerings!.metadata.schemeCategory ?? null).toBeNull();
    expect(offerings!.metadata.schemeType ?? null).toBeNull();
    // Content about several of the AMC's schemes is AMC-scoped, not unknown, so review isn't
    // flooded with REQUIRED_METADATA_MISSING warnings on every multi-fund chunk.
    expect(offerings!.metadata.documentScope).toBe("amc");
    expect(inspection.prepared.report.findings.filter((f) =>
      f.candidateId === offerings!.id && f.ruleCode === "REQUIRED_METADATA_MISSING")).toHaveLength(0);

    // Each stamped chunk gets its own fund and a strategy derived from it, never the cover fund.
    expect(cover!.metadata.fundName).toBe("Mirae Asset Multi Factor Passive FOF");
    expect(cover!.metadata.strategyId).toBe("mirae-asset-multi-factor-passive-fof");
    expect(cover!.metadata.canonicalStrategyName).toBe("Mirae Asset Multi Factor Passive FOF");
    expect(cover!.metadata.documentScope).toBe("strategy");

    expect(flexi!.metadata.fundName).toBe("Mirae Asset Flexi Cap Fund");
    expect(flexi!.metadata.strategyId).toBe("mirae-asset-flexi-cap-fund");
    expect(flexi!.metadata.schemeCategory).toBe("Flexi Cap");
    expect(flexi!.metadata.canonicalStrategyName).toBe("Mirae Asset Flexi Cap Fund");

    // No candidate carries the cover fund's strategy as a document-wide value.
    const coverStrategy = "mirae-asset-multi-factor-passive-fof";
    expect(inspection.prepared.candidates.filter((c) => c.metadata.strategyId === coverStrategy)).toHaveLength(1);
  });

  test("in the SIF collection a multi-fund chunk without its own fund is SIF-umbrella scoped", async () => {
    const { parsed } = await doclingArtifact(rawBytes, multiFundResponse, factsheetName);
    const inspection = preparePdfChunkInspection({
      parsed, sourceDocumentId: "source-document-1", ownership,
      knowledgeScope: { ...knowledgeScope, sourceCollection: "mirae_sif" }, documentType: "Factsheet",
    });
    const offerings = inspection.prepared.candidates.find((c) => (c.metadata.fundName ?? null) === null);
    expect(offerings?.metadata.documentScope).toBe("sif_umbrella");
  });

  test("regression: a document fund never reaches a chunk without its own fund on a multi-fund Factsheet", async () => {
    const { parsed } = await doclingArtifact(rawBytes, multiFundResponse, factsheetName);
    const inspection = preparePdfChunkInspection({
      parsed, sourceDocumentId: "source-document-1", ownership, knowledgeScope, documentType: "Factsheet",
    });

    for (const candidate of inspection.prepared.candidates) {
      const ownFund = candidate.metadata.fundName ?? null;
      if (ownFund === null) {
        expect(candidate.metadata.strategyId ?? null).toBeNull();
        expect(candidate.metadata.canonicalStrategyName ?? null).toBeNull();
        expect(candidate.metadata.schemeCategory ?? null).toBeNull();
      } else {
        // A stamped chunk's strategy is derived from its own fund, not any other chunk's.
        expect(candidate.metadata.strategyId).toBe(ownFund.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
      }
    }
  });

  test("a single-fund Docling factsheet keeps today's shared document metadata on every chunk", async () => {
    // minimalDoclingResponse names exactly one fund (Flexi Cap): the picture chunk still inherits it.
    const { parsed } = await doclingArtifact(rawBytes, minimalDoclingResponse);
    const inspection = preparePdfChunkInspection({
      parsed, sourceDocumentId: "source-document-1", ownership, knowledgeScope, documentType: "Factsheet",
    });

    expect(inspection.prepared.candidates).toHaveLength(2);
    for (const candidate of inspection.prepared.candidates) {
      expect(candidate.metadata.fundName).toBe("Mirae Asset Flexi Cap Fund");
      expect(candidate.metadata.strategyId).toBe("mirae-asset-flexi-cap-fund");
      expect(candidate.metadata.canonicalStrategyName).toBe("Mirae Asset Flexi Cap Fund");
      expect(candidate.metadata.documentScope).toBe("strategy");
    }
  });

  test("the unpdf path is unaffected: a single-scheme factsheet keeps document-level metadata", () => {
    const unpdf: NormalizedPdfParseArtifact = {
      schemaVersion: 1,
      documentVersionId: "version-1",
      source: { filename: "mirae-flexi-cap.pdf", canonicalUrl: "https://www.miraeassetmf.co.in/f.pdf",
        rawSha256: "c".repeat(64), rawByteSize: 10 },
      parser: { parserVersion: "unpdf-test", tableExtractorVersion: "pdfplumber-test" },
      pages: [{ pageNumber: 1, text: "Mirae Asset Flexi Cap Fund\nFlexi Cap\nInvestment objective.", hasTable: false }],
      tables: [],
      diagnostics: { pageCount: 1, emptyPageCount: 0, tableCount: 0, tableExtractionStatus: "succeeded", tableExtractionCode: null },
    };
    const inspection = preparePdfChunkInspection({
      parsed: unpdf, sourceDocumentId: "source-document-1", ownership, knowledgeScope,
    });

    expect(inspection.prepared.candidates.every((c) =>
      c.metadata.fundName === "Mirae Asset Flexi Cap Fund"
      && c.metadata.documentScope === "strategy"
      && c.metadata.strategyId === "mirae-asset-flexi-cap-fund")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ArtifactDescriptor } from "@mf-rag/types";
import type { StageInspectionReviewInput } from "@mf-rag/db";

import {
  ChunkInspectStage,
  type ChunkInspectionReviewRepository,
} from "./chunk-inspect-stage.ts";
import {
  encodeNormalizedParseArtifact,
  parsedPdfMediaType,
  type NormalizedPdfParseArtifact,
} from "./parse-pdf-stage.ts";

function fixture(parserVersion = "unpdf-v1") {
  const parsed: NormalizedPdfParseArtifact = {
    schemaVersion: 1,
    documentVersionId: "version-1",
    source: {
      filename: "Mirae_Flexi_Cap_Factsheet.pdf",
      canonicalUrl: "https://www.miraeassetmf.co.in/docs/flexi-cap.pdf",
      rawSha256: "a".repeat(64),
      rawByteSize: 100,
    },
    parser: { parserVersion, tableExtractorVersion: "pdfplumber-v1" },
    pages: [
      { pageNumber: 1, text: "Mirae Flexi Cap Fund Factsheet January 2026", hasTable: false },
      { pageNumber: 2, text: "Investment objective and portfolio details for investors.", hasTable: false },
    ],
    tables: [],
    diagnostics: {
      pageCount: 2,
      emptyPageCount: 0,
      tableCount: 0,
      tableExtractionStatus: "succeeded",
      tableExtractionCode: null,
    },
  };
  const bytes = encodeNormalizedParseArtifact(parsed);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const descriptor: ArtifactDescriptor = {
    key: `parsed/${checksum}`,
    uri: `memory://${checksum}`,
    sha256: checksum,
    byteSize: bytes.byteLength,
    mediaType: parsedPdfMediaType(),
    producerVersion: "parse-stage-v1",
  };
  return { parsed, bytes, checksum, descriptor };
}

class IdempotentReviewRepository implements ChunkInspectionReviewRepository {
  readonly inputs: Array<StageInspectionReviewInput & {
    documentVersionId: string;
    configRevisionId: string;
    pipelineRunId: string;
  }> = [];
  readonly compatible = new Map<string, string>();

  async stage(input: StageInspectionReviewInput & {
    documentVersionId: string;
    configRevisionId: string;
    pipelineRunId: string;
  }): Promise<{ id: string }> {
    this.inputs.push(input);
    const key = [
      input.documentVersionId,
      input.configRevisionId,
      input.parserVersion,
      input.chunkerVersion,
      input.report.inspectorVersion,
    ].join(":");
    let id = this.compatible.get(key);
    if (!id) {
      id = `review-${this.compatible.size + 1}`;
      this.compatible.set(key, id);
    }
    return { id };
  }
}

function stageFor(fixtureValue: ReturnType<typeof fixture>, repository: IdempotentReviewRepository) {
  return new ChunkInspectStage({
    artifactStore: {
      verify: async (descriptor) => descriptor,
      read: async () => fixtureValue.bytes,
    },
    reviewRepository: repository,
  });
}

function stageInput(fixtureValue: ReturnType<typeof fixture>) {
  return {
    documentVersionId: "version-1",
    pipelineRunId: "pipeline-run-1",
    sourceDocumentId: "source-document-1",
    accessScopeId: "scope-910",
    parsedArtifact: fixtureValue.descriptor,
    expectedParsedChecksum: fixtureValue.checksum,
    trustedContext: {
      accessScopeId: "scope-910",
      accessScopeKey: "mirae-sif",
      externalCode: "910",
      configRevisionId: "revision-1",
      configRevisionChecksum: "b".repeat(64),
      classification: {
        knowledgeDomain: "sif" as const,
        sourceCollection: "mirae_sif" as const,
        amcSlug: "mirae-asset",
      },
    },
  };
}

describe("ChunkInspectStage", () => {
  test("consumes only a parsed artifact and stages universally inspected tenant-owned candidates", async () => {
    const value = fixture();
    const repository = new IdempotentReviewRepository();
    const result = await stageFor(value, repository).execute(stageInput(value));

    expect(result.candidateCount).toBeGreaterThan(0);
    expect(result.outputChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.inputs).toHaveLength(1);
    expect(repository.inputs[0]).toMatchObject({
      documentVersionId: "version-1",
      configRevisionId: "revision-1",
      sourceDocumentId: "source-document-1",
      fileHash: "a".repeat(64),
      ownership: {
        visibilityScope: "TENANT",
        tenantId: "910",
        ownershipManifestId: "source-registry:revision-1",
      },
    });
    expect(repository.inputs[0]!.report.inspectedChunkCount)
      .toBe(repository.inputs[0]!.candidates.length);
    expect(repository.inputs[0]!.candidates.every((candidate) =>
      candidate.pageNumbers.length > 0
      && candidate.metadata.sourceUrl === value.parsed.source.canonicalUrl
      && candidate.metadata.sourceChecksum === value.parsed.source.rawSha256
    )).toBe(true);
  });

  test("a retry returns one compatible review run and implementation drift changes compatibility", async () => {
    const value = fixture();
    const repository = new IdempotentReviewRepository();
    const stage = stageFor(value, repository);
    const first = await stage.execute(stageInput(value));
    const retry = await stage.execute(stageInput(value));

    expect(first.reviewRunId).toBe(retry.reviewRunId);
    expect(first.outputChecksum).toBe(retry.outputChecksum);
    expect(repository.compatible).toHaveLength(1);

    const drifted = fixture("unpdf-v2");
    const driftedResult = await stageFor(drifted, repository).execute(stageInput(drifted));
    expect(driftedResult.reviewRunId).not.toBe(first.reviewRunId);
    expect(driftedResult.outputChecksum).not.toBe(first.outputChecksum);

    const configDrift = {
      ...stageInput(value),
      trustedContext: {
        ...stageInput(value).trustedContext,
        configRevisionId: "revision-2",
        configRevisionChecksum: "c".repeat(64),
      },
    };
    const configResult = await stage.execute(configDrift);
    expect(configResult.reviewRunId).not.toBe(first.reviewRunId);
    expect(configResult.outputChecksum).not.toBe(first.outputChecksum);
  });

  test("checksum and access-scope mismatches fail before review staging", async () => {
    const value = fixture();
    const repository = new IdempotentReviewRepository();
    const stage = stageFor(value, repository);
    await expect(stage.execute({
      ...stageInput(value),
      expectedParsedChecksum: "0".repeat(64),
    })).rejects.toMatchObject({ code: "PARSED_ARTIFACT_CHECKSUM_MISMATCH", classification: "deterministic" });
    await expect(stage.execute({
      ...stageInput(value),
      accessScopeId: "scope-117",
    })).rejects.toMatchObject({ code: "OWNERSHIP_CONTEXT_MISMATCH", classification: "deterministic" });
    expect(repository.inputs).toHaveLength(0);
  });

  test("scheduled inspection rejects local or credential-bearing source provenance", async () => {
    for (const canonicalUrl of ["/tmp/fixture.pdf", "https://user:secret@example.com/fixture.pdf"]) {
      const value = fixture();
      const forged = { ...value.parsed, source: { ...value.parsed.source, canonicalUrl } };
      const bytes = encodeNormalizedParseArtifact(forged);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const descriptor = { ...value.descriptor, sha256: checksum, byteSize: bytes.byteLength };
      const repository = new IdempotentReviewRepository();
      const stage = new ChunkInspectStage({
        artifactStore: { verify: async (item) => item, read: async () => bytes },
        reviewRepository: repository,
      });
      await expect(stage.execute({
        ...stageInput({ ...value, bytes, checksum, descriptor }),
      })).rejects.toMatchObject({ code: "INVALID_SOURCE_PROVENANCE", classification: "deterministic" });
      expect(repository.inputs).toHaveLength(0);
    }
  });
});

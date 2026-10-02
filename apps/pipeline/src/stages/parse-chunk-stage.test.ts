import { describe, expect, test } from "bun:test";

import type { ArtifactDescriptor } from "@mf-rag/types";

import { StageRegistry } from "../runtime/stage-registry.ts";
import { createParserRoutingAdapter, type ParseDocumentAdapter } from "./parse-document.ts";
import {
  ChunkInspectDocumentStage,
  citationMetadataForSourceDocument,
  createParseChunkStageRegistrations,
  type ChunkInspectDocumentAdapter,
} from "./chunk-inspect-document.ts";

const checksum = (character: string) => character.repeat(64);
const identity = (componentVersion: string, config: string) => ({
  releaseIdentity: `sha256:${checksum("a")}`,
  componentVersion,
  configChecksum: checksum(config),
});

describe("parse/chunk stage registration", () => {
  test("derives trusted SEBI citation identity from the logical document key", () => {
    expect(citationMetadataForSourceDocument(
      "sebi-sid:10123",
      "https://www.sebi.gov.in/sebi_data/mutualfundfile/example.pdf",
    )).toEqual({
      sebiSchemeId: "10123",
      sebiUrl: "https://www.sebi.gov.in/sebi_data/mutualfundfile/example.pdf",
    });
    expect(citationMetadataForSourceDocument(
      "catalog:10123",
      "https://example.com/document.pdf",
    )).toBeUndefined();
  });

  test("registers the independent artifact stages in durable order", async () => {
    const calls: string[] = [];
    const registrations = createParseChunkStageRegistrations({
      parse: {
        execute: async () => {
          calls.push("PARSE");
          return { outputRef: "parsed", outputChecksum: checksum("1") };
        },
      },
      parseIdentity: identity("parse-v1", "b"),
      chunkInspect: {
        execute: async () => {
          calls.push("CHUNK_AND_INSPECT");
          return { outputRef: "review:1", outputChecksum: checksum("2") };
        },
      },
      chunkInspectIdentity: identity("chunk-inspect-v1", "c"),
    });
    const registry = new StageRegistry(registrations);
    expect(registry.next("PARSE")?.stage).toBe("CHUNK_AND_INSPECT");
    const context = {
      pipelineRunId: "run-1",
      documentVersionId: "version-1",
      accessScopeId: "scope-1",
      sourceId: "source-1",
      inputChecksum: checksum("0"),
      signal: new AbortController().signal,
    };
    await registry.get("PARSE").handler(context);
    await registry.get("CHUNK_AND_INSPECT").handler(context);
    expect(calls).toEqual(["PARSE", "CHUNK_AND_INSPECT"]);
  });

  describe("parser routing", () => {
    const artifact = (name: string): ArtifactDescriptor => ({
      key: `parsed/${name}`, uri: `memory://${name}`, sha256: checksum("d"), byteSize: 1,
      mediaType: "application/json", producerVersion: name,
    });
    const recording = (name: string, calls: string[]): ParseDocumentAdapter => ({
      execute: async (input) => {
        calls.push(`${name}:${input.parser}:${input.documentVersionId}`);
        return { artifact: artifact(name) };
      },
    });
    const input = (parser: "unpdf" | "docling") => ({
      documentVersionId: "version-1",
      rawArtifact: artifact("raw"),
      filename: "factsheet.pdf",
      canonicalUrl: "https://example.com/factsheet.pdf",
      parser,
    });

    test("sends docling inputs to the Docling stage and unpdf inputs to ParsePdfStage", async () => {
      const calls: string[] = [];
      const router = createParserRoutingAdapter({ unpdf: recording("unpdf", calls), docling: recording("docling", calls) });

      expect((await router.execute(input("docling"))).artifact.producerVersion).toBe("docling");
      expect((await router.execute(input("unpdf"))).artifact.producerVersion).toBe("unpdf");
      expect(calls).toEqual(["docling:docling:version-1", "unpdf:unpdf:version-1"]);
    });

    test("fails deterministically when Docling is selected but not configured", async () => {
      const calls: string[] = [];
      const router = createParserRoutingAdapter({ unpdf: recording("unpdf", calls), docling: null });

      await expect(router.execute(input("docling")))
        .rejects.toMatchObject({ code: "DOCLING_PARSER_NOT_CONFIGURED", classification: "deterministic" });
      expect((await router.execute(input("unpdf"))).artifact.producerVersion).toBe("unpdf");
      expect(calls).toEqual(["unpdf:unpdf:version-1"]);
    });
  });

  describe("chunk stage source document type", () => {
    const parsedArtifact: ArtifactDescriptor = {
      key: "parsed/1", uri: "memory://parsed", sha256: checksum("e"), byteSize: 1,
      mediaType: "application/json", producerVersion: "parse-v1",
    };
    const context = {
      pipelineRunId: "run-1",
      documentVersionId: "version-1",
      accessScopeId: "scope-1",
      sourceId: "source-1",
      inputChecksum: checksum("e"),
      signal: new AbortController().signal,
    };
    const trustedContext = {
      accessScopeId: "scope-1",
      accessScopeKey: "mirae-mf",
      externalCode: "117",
      configRevisionId: "revision-1",
      configRevisionChecksum: checksum("f"),
      classification: { knowledgeDomain: "mutual_fund" as const, sourceCollection: "mirae_mf" as const, amcSlug: "mirae-asset" },
    };
    const run = async (documentType?: "Factsheet") => {
      const received: Parameters<ChunkInspectDocumentAdapter["execute"]>[0][] = [];
      const stage = new ChunkInspectDocumentStage({
        repository: {
          loadInput: async () => ({
            sourceDocumentId: "document-1",
            parsedArtifact,
            trustedContext,
            ...(documentType ? { documentType } : {}),
          }),
        },
        adapter: {
          execute: async (input) => {
            received.push(input);
            return { reviewRunId: "review-1", outputChecksum: checksum("1") };
          },
        },
      });
      await stage.execute(context);
      return received[0]!;
    };

    test("passes the source's declared document type to the chunk adapter", async () => {
      expect((await run("Factsheet")).documentType).toBe("Factsheet");
    });

    test("passes no document type when the source declares none", async () => {
      expect((await run()).documentType).toBeUndefined();
    });
  });
});

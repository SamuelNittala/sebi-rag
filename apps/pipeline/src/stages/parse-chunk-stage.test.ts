import { describe, expect, test } from "bun:test";

import { StageRegistry } from "../runtime/stage-registry.ts";
import { createParseChunkStageRegistrations } from "./chunk-inspect-document.ts";

const checksum = (character: string) => character.repeat(64);
const identity = (componentVersion: string, config: string) => ({
  releaseIdentity: `sha256:${checksum("a")}`,
  componentVersion,
  configChecksum: checksum(config),
});

describe("parse/chunk stage registration", () => {
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
});

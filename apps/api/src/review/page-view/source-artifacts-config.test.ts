import { describe, expect, test } from "bun:test";

import type { Database } from "@mf-rag/db/client";

import { reviewSourceArtifactsFromEnvironment } from "./source-artifacts-config.ts";
import { ReviewSourceArtifacts } from "./source-artifacts.ts";

const NO_DB = {} as Database;

describe("reviewSourceArtifactsFromEnvironment", () => {
  test("leaves the page view disabled when ARTIFACT_STORE is unset or blank", () => {
    expect(reviewSourceArtifactsFromEnvironment(NO_DB, {})).toBeUndefined();
    expect(reviewSourceArtifactsFromEnvironment(NO_DB, { ARTIFACT_STORE: "  " })).toBeUndefined();
  });

  test("builds the source from a valid filesystem store configuration", () => {
    const configured = reviewSourceArtifactsFromEnvironment(NO_DB, {
      ARTIFACT_STORE: "filesystem",
      ARTIFACT_FILESYSTEM_ROOT: "/tmp/review-artifacts",
    });

    expect(configured?.kind).toBe("filesystem");
    expect(configured?.sourceArtifacts).toBeInstanceOf(ReviewSourceArtifacts);
  });

  test("builds the source from a valid S3 configuration", () => {
    const configured = reviewSourceArtifactsFromEnvironment(NO_DB, {
      ARTIFACT_STORE: "s3",
      ARTIFACT_S3_BUCKET: "bucket",
      ARTIFACT_S3_REGION: "ap-south-1",
      ARTIFACT_S3_CREDENTIALS_MODE: "ambient",
    });

    expect(configured?.kind).toBe("s3");
  });

  test("fails fast on an invalid configuration", () => {
    expect(() => reviewSourceArtifactsFromEnvironment(NO_DB, { ARTIFACT_STORE: "ftp" })).toThrow("ARTIFACT_STORE must be filesystem or s3.");
    expect(() => reviewSourceArtifactsFromEnvironment(NO_DB, { ARTIFACT_STORE: "filesystem" })).toThrow("ARTIFACT_FILESYSTEM_ROOT is required.");
    expect(() => reviewSourceArtifactsFromEnvironment(NO_DB, { ARTIFACT_STORE: "s3", ARTIFACT_S3_BUCKET: "b" })).toThrow();
    expect(() => reviewSourceArtifactsFromEnvironment(NO_DB, {
      NODE_ENV: "production",
      ARTIFACT_STORE: "filesystem",
      ARTIFACT_FILESYSTEM_ROOT: "/tmp/x",
    })).toThrow("Production pipeline requires ARTIFACT_STORE=s3.");
  });
});

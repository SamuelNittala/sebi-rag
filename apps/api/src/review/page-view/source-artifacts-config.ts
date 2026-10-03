/**
 * Optional artifact store wiring for the review page view. The API reads the
 * same `ARTIFACT_*` (and AWS) environment as the pipeline workers:
 * unset `ARTIFACT_STORE` disables the page view (its routes answer 503), an
 * invalid configuration throws at startup.
 */

import type { Database } from "@mf-rag/db/client";

import { artifactStoreFromEnvironment } from "../../../../pipeline/src/operations/artifact-store-config.ts";
import { ReviewSourceArtifacts } from "./source-artifacts.ts";

export interface ConfiguredReviewSourceArtifacts {
  readonly kind: "filesystem" | "s3";
  readonly sourceArtifacts: ReviewSourceArtifacts;
}

export function reviewSourceArtifactsFromEnvironment(
  db: Database,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfiguredReviewSourceArtifacts | undefined {
  if (!env.ARTIFACT_STORE?.trim()) return undefined;
  const { kind, store } = artifactStoreFromEnvironment(env);
  return { kind, sourceArtifacts: new ReviewSourceArtifacts(db, store) };
}

import type { ArtifactStore } from "../artifacts/artifact-store.ts";
import { FilesystemArtifactStore } from "../artifacts/filesystem-artifact-store.ts";
import { S3ArtifactStore } from "../artifacts/s3-artifact-store.ts";

export interface ArtifactStoreRuntimeConfig {
  readonly kind: "filesystem" | "s3";
  readonly store: ArtifactStore;
}

/** Production refuses local storage and incomplete S3/IAM configuration. */
export function artifactStoreFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ArtifactStoreRuntimeConfig {
  const production = env.NODE_ENV === "production";
  const kind = requiredEnvironmentValue(env.ARTIFACT_STORE, "ARTIFACT_STORE");
  if (kind === "filesystem") {
    if (production) throw new Error("Production pipeline requires ARTIFACT_STORE=s3.");
    return { kind, store: new FilesystemArtifactStore(requiredEnvironmentValue(env.ARTIFACT_FILESYSTEM_ROOT, "ARTIFACT_FILESYSTEM_ROOT")) };
  }
  if (kind !== "s3") throw new Error("ARTIFACT_STORE must be filesystem or s3.");
  const credentialsMode = requiredEnvironmentValue(env.ARTIFACT_S3_CREDENTIALS_MODE, "ARTIFACT_S3_CREDENTIALS_MODE");
  if (credentialsMode !== "ambient" && credentialsMode !== "static") {
    throw new Error("ARTIFACT_S3_CREDENTIALS_MODE must be ambient or static.");
  }
  if (credentialsMode === "static") {
    requiredEnvironmentValue(env.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID");
    requiredEnvironmentValue(env.AWS_SECRET_ACCESS_KEY, "AWS_SECRET_ACCESS_KEY");
  }
  return {
    kind,
    store: new S3ArtifactStore({
      bucket: requiredEnvironmentValue(env.ARTIFACT_S3_BUCKET, "ARTIFACT_S3_BUCKET"),
      region: requiredEnvironmentValue(env.ARTIFACT_S3_REGION, "ARTIFACT_S3_REGION"),
      endpoint: production ? requiredEnvironmentValue(env.ARTIFACT_S3_ENDPOINT, "ARTIFACT_S3_ENDPOINT") : env.ARTIFACT_S3_ENDPOINT,
      prefix: env.ARTIFACT_S3_PREFIX,
      forcePathStyle: env.ARTIFACT_S3_FORCE_PATH_STYLE === "true",
    }),
  };
}

export function requiredEnvironmentValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

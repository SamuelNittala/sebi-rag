import { createHash } from "node:crypto";
import type { ArtifactDescriptor } from "@mf-rag/types";

export type { ArtifactDescriptor } from "@mf-rag/types";

export interface PutArtifactInput {
  readonly namespace: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly producerVersion: string;
}

export interface OrphanArtifact {
  readonly key: string;
  readonly uri: string;
  readonly byteSize: number;
  readonly lastModifiedAt: Date;
}

export interface ArtifactStore {
  /** Writes or reuses an immutable object and returns only after integrity verification. */
  put(input: PutArtifactInput): Promise<ArtifactDescriptor>;
  read(descriptor: ArtifactDescriptor): Promise<Uint8Array>;
  /** Reads bytes once while validating the descriptor, metadata, size, and checksum. */
  readVerified(descriptor: ArtifactDescriptor): Promise<Uint8Array>;
  verify(descriptor: ArtifactDescriptor): Promise<ArtifactDescriptor>;
  /** Reporting only. U3 deliberately performs no destructive object deletion. */
  listOrphans(referencedKeys: ReadonlySet<string>, olderThan: Date): Promise<readonly OrphanArtifact[]>;
}

/**
 * Storage is complete and verified before persistence is invoked. If
 * persistence fails, the immutable object is an observable orphan and a retry
 * safely reuses it; no ready database record can point at a missing upload.
 */
export async function persistVerifiedArtifact<T>(
  store: ArtifactStore,
  input: PutArtifactInput,
  persist: (descriptor: ArtifactDescriptor) => Promise<T>,
): Promise<T> {
  const verified = await store.put(input);
  return persist(verified);
}

export function validateArtifactInput(input: PutArtifactInput): void {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(input.namespace) || input.namespace.includes("..")) {
    throw new Error("Artifact namespace is invalid.");
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error("Artifact checksum must be a lowercase SHA-256 value.");
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
    throw new Error("Artifact byte size must be a non-negative safe integer.");
  }
  if (!input.mediaType.trim() || !input.producerVersion.trim()) {
    throw new Error("Artifact media type and producer version are required.");
  }
  if (input.bytes.byteLength !== input.byteSize) {
    throw new Error(`Artifact byte size mismatch: expected ${input.byteSize}, observed ${input.bytes.byteLength}.`);
  }
  const observedSha256 = sha256Hex(input.bytes);
  if (observedSha256 !== input.sha256) {
    throw new Error(`Artifact checksum mismatch: expected ${input.sha256}, observed ${observedSha256}.`);
  }
}

export function contentAddressedKey(namespace: string, sha256: string): string {
  const normalized = namespace.replace(/^\/+|\/+$/g, "");
  return `${normalized}/${sha256.slice(0, 2)}/${sha256}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertArtifactIntegrity(
  descriptor: ArtifactDescriptor,
  bytes: Uint8Array,
): void {
  const observedSha256 = sha256Hex(bytes);
  if (bytes.byteLength !== descriptor.byteSize || observedSha256 !== descriptor.sha256) {
    throw new Error(
      `Artifact integrity verification failed for ${descriptor.key}: expected ${descriptor.byteSize}/${descriptor.sha256}, observed ${bytes.byteLength}/${observedSha256}.`,
    );
  }
}

export function assertSafeArtifactKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("\\") || key.split("/").includes("..")) {
    throw new Error("Artifact key is unsafe.");
  }
}

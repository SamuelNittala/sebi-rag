import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import type { ArtifactStore, PutArtifactInput } from "./artifact-store.ts";
import { persistVerifiedArtifact } from "./artifact-store.ts";
import { FilesystemArtifactStore } from "./filesystem-artifact-store.ts";
import { S3ArtifactStore, type S3CommandClient } from "./s3-artifact-store.ts";

const bytes = new TextEncoder().encode("%PDF-1.7\nimmutable artifact fixture\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const input: PutArtifactInput = {
  namespace: "raw",
  bytes,
  sha256,
  byteSize: bytes.byteLength,
  mediaType: "application/pdf",
  producerVersion: "fetcher-v1",
};

class FakeS3Client implements S3CommandClient {
  readonly objects = new Map<string, {
    body: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
    checksumSHA256?: string;
    lastModified: Date;
  }>();

  async send(command: unknown): Promise<any> {
    if (command instanceof PutObjectCommand) {
      const request = command.input;
      const key = request.Key!;
      if (request.IfNoneMatch === "*" && this.objects.has(key)) {
        throw new S3ServiceException({ name: "PreconditionFailed", $fault: "client", $metadata: { httpStatusCode: 412 } });
      }
      if (!(request.Body instanceof Uint8Array)) throw new Error("Fake S3 expects an in-memory body.");
      const body = request.Body;
      this.objects.set(key, {
        body,
        contentType: request.ContentType,
        metadata: request.Metadata,
        checksumSHA256: request.ChecksumSHA256,
        lastModified: new Date(),
      });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const stored = this.objects.get(command.input.Key!);
      if (!stored) {
        throw new S3ServiceException({ name: "NotFound", $fault: "client", $metadata: { httpStatusCode: 404 } });
      }
      return {
        ContentLength: stored.body.byteLength,
        ContentType: stored.contentType,
        Metadata: stored.metadata,
        ChecksumSHA256: stored.checksumSHA256,
        LastModified: stored.lastModified,
      };
    }
    if (command instanceof GetObjectCommand) {
      const stored = this.objects.get(command.input.Key!);
      if (!stored) {
        throw new S3ServiceException({ name: "NoSuchKey", $fault: "client", $metadata: { httpStatusCode: 404 } });
      }
      return { Body: { transformToByteArray: async () => stored.body } };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return {
        Contents: [...this.objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([Key, value]) => ({ Key, Size: value.body.byteLength, LastModified: value.lastModified })),
        IsTruncated: false,
      };
    }
    throw new Error(`Unsupported fake S3 command: ${String(command)}`);
  }
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function contractStores(): Promise<Array<{ name: string; store: ArtifactStore; inspect: () => Promise<Uint8Array> }>> {
  const root = await mkdtemp(join(tmpdir(), "mf-rag-artifacts-"));
  temporaryRoots.push(root);
  const filesystem = new FilesystemArtifactStore(root);
  const s3Client = new FakeS3Client();
  const s3 = new S3ArtifactStore({ bucket: "pipeline-test", prefix: "artifacts", client: s3Client });
  const expectedKey = `raw/${sha256.slice(0, 2)}/${sha256}`;
  return [
    {
      name: "filesystem",
      store: filesystem,
      inspect: () => readFile(join(root, expectedKey)),
    },
    {
      name: "s3-compatible",
      store: s3,
      inspect: async () => s3Client.objects.get(`artifacts/${expectedKey}`)!.body,
    },
  ];
}

describe("artifact store contract", () => {
  test("filesystem and S3-compatible adapters exchange immutable verified bytes", async () => {
    for (const candidate of await contractStores()) {
      const first = await candidate.store.put(input);
      const retry = await candidate.store.put(input);

      expect(first, candidate.name).toEqual(retry);
      expect(first).toMatchObject({ sha256, byteSize: bytes.byteLength, mediaType: "application/pdf", producerVersion: "fetcher-v1" });
      expect(await candidate.store.read(first)).toEqual(bytes);
      expect(await candidate.store.readVerified(first)).toEqual(bytes);
      expect(await candidate.inspect()).toEqual(bytes);
      await expect(candidate.store.verify(first)).resolves.toEqual(first);
    }
  });

  test("rejects caller checksum and size mismatches before writing", async () => {
    for (const candidate of await contractStores()) {
      await expect(candidate.store.put({ ...input, sha256: "0".repeat(64) })).rejects.toThrow("checksum");
      await expect(candidate.store.put({ ...input, byteSize: input.byteSize + 1 })).rejects.toThrow("byte size");
      expect(await candidate.store.listOrphans(new Set(), new Date(Date.now() + 1_000))).toHaveLength(0);
    }
  });

  test("verification detects durable-object corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-rag-artifacts-corrupt-"));
    temporaryRoots.push(root);
    const store = new FilesystemArtifactStore(root);
    const descriptor = await store.put(input);
    await Bun.write(join(root, descriptor.key), new Uint8Array([1, 2, 3]));
    await expect(store.verify(descriptor)).rejects.toThrow("integrity");
  });

  test("a retry after upload but before persistence reuses storage and only persists after verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-rag-artifacts-retry-"));
    temporaryRoots.push(root);
    const store = new FilesystemArtifactStore(root);
    const uploaded = await store.put(input);
    let calls = 0;

    await expect(persistVerifiedArtifact(store, input, async () => {
      calls++;
      throw new Error("database unavailable");
    })).rejects.toThrow("database unavailable");

    const persisted = await persistVerifiedArtifact(store, input, async (descriptor) => {
      calls++;
      return descriptor;
    });
    expect(persisted).toEqual(uploaded);
    expect(calls).toBe(2);
  });

  test("orphan inspection is non-destructive and excludes referenced or recent objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-rag-artifacts-orphans-"));
    temporaryRoots.push(root);
    const store = new FilesystemArtifactStore(root);
    const descriptor = await store.put(input);

    expect(await store.listOrphans(new Set([descriptor.key]), new Date(Date.now() + 1_000))).toEqual([]);
    expect(await store.listOrphans(new Set(), new Date(0))).toEqual([]);
    expect(await store.listOrphans(new Set(), new Date(Date.now() + 1_000))).toHaveLength(1);
    expect(await store.read(descriptor)).toEqual(bytes);
  });
});

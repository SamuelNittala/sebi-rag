import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  assertArtifactIntegrity,
  assertSafeArtifactKey,
  contentAddressedKey,
  type ArtifactDescriptor,
  type ArtifactStore,
  type OrphanArtifact,
  type PutArtifactInput,
  validateArtifactInput,
} from "./artifact-store.ts";

export interface S3CommandClient {
  send(command: unknown): Promise<any>;
}

export interface S3ArtifactStoreOptions {
  readonly bucket: string;
  readonly prefix?: string;
  readonly client?: S3CommandClient;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
}

export class S3ArtifactStore implements ArtifactStore {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: S3CommandClient;

  constructor(options: S3ArtifactStoreOptions) {
    if (!options.bucket.trim()) throw new Error("Artifact S3 bucket is required.");
    this.#bucket = options.bucket;
    this.#prefix = normalizePrefix(options.prefix ?? "");
    this.#client = options.client ?? new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
    });
  }

  async put(input: PutArtifactInput): Promise<ArtifactDescriptor> {
    validateArtifactInput(input);
    const key = contentAddressedKey(input.namespace, input.sha256);
    const objectKey = this.#objectKey(key);
    try {
      await this.#client.send(new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: input.bytes,
        ContentLength: input.byteSize,
        ContentType: input.mediaType,
        ChecksumSHA256: Buffer.from(input.sha256, "hex").toString("base64"),
        Metadata: {
          sha256: input.sha256,
          "producer-version": input.producerVersion,
        },
        IfNoneMatch: "*",
      }));
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
    }

    const descriptor: ArtifactDescriptor = {
      key,
      uri: `s3://${this.#bucket}/${objectKey}`,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mediaType: input.mediaType,
      producerVersion: input.producerVersion,
    };
    return this.verify(descriptor);
  }

  async read(descriptor: ArtifactDescriptor): Promise<Uint8Array> {
    const result = await this.#client.send(new GetObjectCommand({
      Bucket: this.#bucket,
      Key: this.#objectKey(descriptor.key),
      ChecksumMode: "ENABLED",
    }));
    return readS3Body(result.Body, descriptor.byteSize);
  }

  async verify(descriptor: ArtifactDescriptor): Promise<ArtifactDescriptor> {
    const objectKey = this.#objectKey(descriptor.key);
    if (descriptor.uri !== `s3://${this.#bucket}/${objectKey}`) {
      throw new Error("Artifact URI does not match its S3 key.");
    }
    let head;
    try {
      head = await this.#client.send(new HeadObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        ChecksumMode: "ENABLED",
      }));
    } catch (error) {
      throw new Error(`Artifact integrity verification failed because ${descriptor.key} is unreadable.`, { cause: error });
    }
    const expectedChecksum = Buffer.from(descriptor.sha256, "hex").toString("base64");
    if (
      head.ContentLength !== descriptor.byteSize
      || head.ContentType !== descriptor.mediaType
      || head.Metadata?.sha256 !== descriptor.sha256
      || head.Metadata?.["producer-version"] !== descriptor.producerVersion
      || (head.ChecksumSHA256 && head.ChecksumSHA256 !== expectedChecksum)
    ) {
      throw new Error(`Artifact integrity metadata verification failed for ${descriptor.key}.`);
    }
    const bytes = await this.read(descriptor);
    assertArtifactIntegrity(descriptor, bytes);
    return descriptor;
  }

  async listOrphans(
    referencedKeys: ReadonlySet<string>,
    olderThan: Date,
  ): Promise<readonly OrphanArtifact[]> {
    const objects: OrphanArtifact[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.#client.send(new ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: this.#prefix || undefined,
        ContinuationToken: continuationToken,
      }));
      for (const object of result.Contents ?? []) {
        if (!object.Key || !object.LastModified) continue;
        const key = this.#portableKey(object.Key);
        if (key && !referencedKeys.has(key) && object.LastModified < olderThan) {
          objects.push({
            key,
            uri: `s3://${this.#bucket}/${object.Key}`,
            byteSize: object.Size ?? 0,
            lastModifiedAt: object.LastModified,
          });
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects.sort((left, right) => left.key.localeCompare(right.key));
  }

  #objectKey(key: string): string {
    assertSafeArtifactKey(key);
    return this.#prefix ? `${this.#prefix}/${key}` : key;
  }

  #portableKey(objectKey: string): string | null {
    if (!this.#prefix) return objectKey;
    const prefix = `${this.#prefix}/`;
    return objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : null;
  }
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (normalized) assertSafeArtifactKey(normalized);
  return normalized;
}

function isPreconditionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

async function readS3Body(body: unknown, expectedSize: number): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body && typeof body === "object" && "transformToByteArray" in body) {
    return (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  }
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const combined = new Uint8Array(expectedSize);
    let offset = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      if (offset + bytes.byteLength > expectedSize) {
        throw new Error("S3 artifact response exceeded its declared byte size.");
      }
      combined.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== expectedSize) throw new Error("S3 artifact response did not match its declared byte size.");
    return combined;
  }
  throw new Error("S3 artifact response did not contain a readable body.");
}

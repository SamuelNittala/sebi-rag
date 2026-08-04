import { access, link, mkdir, opendir, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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

export class FilesystemArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async healthCheck(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await access(this.#root, constants.R_OK | constants.W_OK);
  }

  async put(input: PutArtifactInput): Promise<ArtifactDescriptor> {
    validateArtifactInput(input);
    const key = contentAddressedKey(input.namespace, input.sha256);
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, input.bytes, { flag: "wx" });
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }

    const descriptor: ArtifactDescriptor = {
      key,
      uri: pathToFileURL(path).href,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mediaType: input.mediaType,
      producerVersion: input.producerVersion,
    };
    return this.verify(descriptor);
  }

  async read(descriptor: ArtifactDescriptor): Promise<Uint8Array> {
    return new Uint8Array(await Bun.file(this.#pathFor(descriptor.key)).arrayBuffer());
  }

  async readVerified(descriptor: ArtifactDescriptor): Promise<Uint8Array> {
    const expectedUri = pathToFileURL(this.#pathFor(descriptor.key)).href;
    if (descriptor.uri !== expectedUri) throw new Error("Artifact URI does not match its filesystem key.");
    const bytes = await this.read(descriptor).catch((error) => {
      throw new Error(`Artifact integrity verification failed because ${descriptor.key} is unreadable.`, { cause: error });
    });
    assertArtifactIntegrity(descriptor, bytes);
    return bytes;
  }

  async verify(descriptor: ArtifactDescriptor): Promise<ArtifactDescriptor> {
    await this.readVerified(descriptor);
    return descriptor;
  }

  async listOrphans(
    referencedKeys: ReadonlySet<string>,
    olderThan: Date,
  ): Promise<readonly OrphanArtifact[]> {
    const orphans: OrphanArtifact[] = [];
    for await (const path of walkFiles(this.#root)) {
      if (path.endsWith(".tmp")) continue;
      const metadata = await stat(path);
      const key = relative(this.#root, path).split(sep).join("/");
      if (!referencedKeys.has(key) && metadata.mtime < olderThan) {
        orphans.push({
          key,
          uri: pathToFileURL(path).href,
          byteSize: metadata.size,
          lastModifiedAt: metadata.mtime,
        });
      }
    }
    return orphans.sort((left, right) => left.key.localeCompare(right.key));
  }

  #pathFor(key: string): string {
    assertSafeArtifactKey(key);
    const path = resolve(this.#root, key);
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Artifact key escapes the filesystem root.");
    }
    return path;
  }
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let directory;
  try {
    directory = await opendir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else yield path;
  }
}

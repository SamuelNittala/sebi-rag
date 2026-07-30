import { createHash } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  validateFaqSource,
  type FaqSourceDefinition,
} from "./faq-sources.ts";

export interface CuratedDownloadOptions {
  root?: string;
  fetcher?: typeof fetch;
}

export interface CuratedDownloadResult {
  sourceId: string;
  sha256: string;
  artifactPath: string;
  reused: boolean;
  byteLength: number;
  finalUrl: string;
}

const DEFAULT_ROOT = "data/curated-faq";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

async function readVerifiedArtifact(
  artifactPath: string,
  expectedSha256: string,
): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await readFile(artifactPath));
    if (!hasPdfSignature(bytes) || sha256(bytes) !== expectedSha256) {
      throw new Error(`Existing curated artifact failed integrity verification: ${artifactPath}`);
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function downloadCuratedFaqSource(
  sourceInput: FaqSourceDefinition,
  options: CuratedDownloadOptions = {},
): Promise<CuratedDownloadResult> {
  const source = validateFaqSource(sourceInput);
  const root = resolve(options.root ?? DEFAULT_ROOT);
  const artifactPath = join(root, "artifacts", source.id, `${source.sha256}.pdf`);
  const existing = await readVerifiedArtifact(artifactPath, source.sha256);
  if (existing) {
    return {
      sourceId: source.id,
      sha256: source.sha256,
      artifactPath,
      reused: true,
      byteLength: existing.byteLength,
      finalUrl: source.canonicalUrl,
    };
  }

  const response = await (options.fetcher ?? fetch)(source.canonicalUrl, {
    redirect: "follow",
    headers: { accept: "application/pdf" },
  });
  if (!response.ok) {
    throw new Error(`FAQ source download failed (${response.status}): ${source.id}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/pdf")) {
    throw new Error(`FAQ source response is not application/pdf: ${source.id}`);
  }
  const canonicalHost = new URL(source.canonicalUrl).hostname.replace(/^www\./, "");
  const finalHost = new URL(response.url || source.canonicalUrl).hostname.replace(/^www\./, "");
  if (canonicalHost !== finalHost) {
    throw new Error(`FAQ source redirected outside its trusted host: ${finalHost}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`FAQ source response is empty: ${source.id}`);
  }
  if (!hasPdfSignature(bytes)) {
    throw new Error(`FAQ source response lacks a %PDF- signature: ${source.id}`);
  }
  const observedSha256 = sha256(bytes);
  if (observedSha256 !== source.sha256) {
    throw new Error(
      `FAQ source checksum mismatch for ${source.id}: expected ${source.sha256}, observed ${observedSha256}`,
    );
  }

  await mkdir(dirname(artifactPath), { recursive: true });
  const tempPath = `${artifactPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, bytes, { flag: "wx" });
  try {
    await link(tempPath, artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }

  const stored = await readVerifiedArtifact(artifactPath, source.sha256);
  if (!stored) {
    throw new Error(`FAQ source artifact was not stored: ${artifactPath}`);
  }
  return {
    sourceId: source.id,
    sha256: source.sha256,
    artifactPath,
    reused: false,
    byteLength: stored.byteLength,
    finalUrl: response.url || source.canonicalUrl,
  };
}

import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { downloadCuratedFaqSource } from "./curated-downloader.ts";
import type { FaqSourceDefinition } from "./faq-sources.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nsanitized fixture\n%%EOF");

function fixtureSource(sha256: string): FaqSourceDefinition {
  return {
    id: "fixture-source",
    title: "Fixture FAQ",
    publisher: "Fixture Authority",
    canonicalUrl: "https://www.nism.ac.in/sanitized-fixture.pdf",
    sourceDate: "2024-01-01",
    sha256,
    authority: "regulator",
    parserProfile: "sebi-unnumbered-v1",
    expectedQuestionCount: { min: 1, max: 2 },
    knowledgeDomain: "mutual_fund",
    sourceCollection: "general_mf_faq",
    documentKind: "FAQ",
    ownership: {
      visibilityScope: "GLOBAL",
      tenantId: null,
      ownershipManifestId: "curated-global-faq",
      ownershipManifestVersion: 1,
    },
  };
}

describe("curated FAQ downloader", () => {
  test("validates PDF identity and reuses the immutable checksum artifact", async () => {
    const sha256 = createHash("sha256").update(PDF_BYTES).digest("hex");
    const root = await mkdtemp(join(tmpdir(), "faq-download-"));
    let calls = 0;
    const fetcher: typeof fetch = (async () => {
      calls += 1;
      return new Response(PDF_BYTES, {
        headers: { "content-type": "application/pdf" },
      });
    }) as unknown as typeof fetch;

    const first = await downloadCuratedFaqSource(fixtureSource(sha256), { root, fetcher });
    const second = await downloadCuratedFaqSource(fixtureSource(sha256), { root, fetcher });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.artifactPath).toBe(second.artifactPath);
    expect(calls).toBe(1);
    expect(new Uint8Array(await readFile(first.artifactPath))).toEqual(PDF_BYTES);
  });

  test("rejects checksum mismatches and keeps changed checksums in separate paths", async () => {
    const sha256 = createHash("sha256").update(PDF_BYTES).digest("hex");
    const root = await mkdtemp(join(tmpdir(), "faq-download-"));
    const fetcher: typeof fetch = (async () =>
      new Response(PDF_BYTES, {
        headers: { "content-type": "application/pdf" },
      })) as unknown as typeof fetch;

    await expect(downloadCuratedFaqSource(fixtureSource("f".repeat(64)), {
      root,
      fetcher,
    })).rejects.toThrow(/checksum/i);

    const original = await downloadCuratedFaqSource(fixtureSource(sha256), { root, fetcher });
    const changedBytes = new TextEncoder().encode("%PDF-1.7\nchanged fixture\n%%EOF");
    const changedHash = createHash("sha256").update(changedBytes).digest("hex");
    const changed = await downloadCuratedFaqSource(fixtureSource(changedHash), {
      root,
      fetcher: (async () => new Response(changedBytes, {
        headers: { "content-type": "application/pdf" },
      })) as unknown as typeof fetch,
    });

    expect(original.artifactPath).not.toBe(changed.artifactPath);
  });
});

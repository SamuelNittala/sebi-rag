import { afterAll, describe, expect, test } from "bun:test";

import {
  decodeDoclingParseArtifact,
  doclingPdfMediaType,
} from "../../../../ingestion/src/stages/docling-parse-stage.ts";
import { sha256Hex } from "../../../../pipeline/src/artifacts/artifact-store.ts";
import {
  createFixtureRoot,
  createStoredDoclingFixture,
  DOCLING_GOLDENS,
  removeFixtureRoot,
} from "./test-fixtures.ts";

describe("createStoredDoclingFixture", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map(removeFixtureRoot));
  });

  test("stores the golden PDF and a Docling parse artifact that decodes and verifies", async () => {
    const fixture = await createStoredDoclingFixture("mirae-flexi-cap-p34-35");
    roots.push(fixture.root);

    const rawBytes = await fixture.store.readVerified(fixture.rawArtifact);
    const parsedBytes = await fixture.store.readVerified(fixture.parseArtifact);
    const decoded = decodeDoclingParseArtifact(parsedBytes);

    expect(rawBytes).toEqual(fixture.pdfBytes);
    expect(fixture.rawArtifact).toMatchObject({ mediaType: "application/pdf", sha256: sha256Hex(fixture.pdfBytes) });
    expect(fixture.parseArtifact.mediaType).toBe(doclingPdfMediaType());
    expect(fixture.parseArtifact.key).toStartWith(`parsed/${fixture.documentVersionId}/`);
    expect(decoded).toEqual(fixture.parsed);
    expect(decoded.documentVersionId).toBe(fixture.documentVersionId);
    expect(decoded.source.rawSha256).toBe(fixture.rawArtifact.sha256);
    expect(decoded.diagnostics.pageCount).toBe(2);
    expect(decoded.chunks).toEqual(fixture.wire.chunks);
  });

  test("every golden builds a valid artifact; distinct version ids give distinct artifacts in one store", async () => {
    const root = await createFixtureRoot();
    roots.push(root);
    const fixtures = await Promise.all(DOCLING_GOLDENS.map((name) => createStoredDoclingFixture(name, { root })));
    const twin = await createStoredDoclingFixture("mirae-flexi-cap-p34-35", { root });

    for (const fixture of fixtures) {
      expect(decodeDoclingParseArtifact(await fixture.store.readVerified(fixture.parseArtifact)).chunks.length)
        .toBeGreaterThan(0);
    }
    expect(new Set([...fixtures, twin].map((fixture) => fixture.parseArtifact.sha256)).size).toBe(fixtures.length + 1);
  });
});

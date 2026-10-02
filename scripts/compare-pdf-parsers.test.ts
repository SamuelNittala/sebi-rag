import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { parseAccessScopeManifestYaml } from "../apps/pipeline/src/config/access-scope-manifest.ts";
import { parseCompareArgs, resolveCompareDocumentType } from "./compare-pdf-parsers.ts";

const repoRoot = resolve(import.meta.dir, "..");

describe("parseCompareArgs", () => {
  test("collects repeated --pdf flags and applies defaults", () => {
    const args = parseCompareArgs(["--pdf", "a.pdf", "--pdf", "b.pdf"], { tmpRoot: "/scratch", now: new Date("2026-10-02T10:20:30Z") });
    expect(args.pdfs).toEqual([resolve("a.pdf"), resolve("b.pdf")]);
    expect(args.scopePath).toBe(join(repoRoot, "config/access-scopes/117-mirae-mf.yml"));
    expect(args.doclingUrl).toBe("http://localhost:8090");
    expect(args.doclingVersion).toBeNull();
    expect(args.pageRange).toBeNull();
    expect(args.sourceKey).toBeNull();
    expect(args.documentType).toBeNull();
    expect(args.outDir).toBe("/scratch/mf-rag-parse-compare/2026-10-02T10-20-30Z");
  });

  test("parses --pages, --out, --docling-url and --docling-version", () => {
    const args = parseCompareArgs([
      "--pdf", "a.pdf", "--pages", "34-35", "--out", "/scratch/run",
      "--docling-url", "http://127.0.0.1:9000", "--docling-version", "docling-x",
    ], { tmpRoot: "/scratch", now: new Date() });
    expect(args.pageRange).toEqual({ first: 34, last: 35 });
    expect(args.outDir).toBe("/scratch/run");
    expect(args.doclingUrl).toBe("http://127.0.0.1:9000");
    expect(args.doclingVersion).toBe("docling-x");
  });

  test("rejects an output directory inside data/", () => {
    expect(() => parseCompareArgs(["--pdf", "a.pdf", "--out", join(repoRoot, "data/reports")], { tmpRoot: "/scratch", now: new Date() }))
      .toThrow(/data\//);
  });

  test("requires at least one PDF and rejects unknown flags", () => {
    expect(() => parseCompareArgs([], { tmpRoot: "/scratch", now: new Date() })).toThrow(/--pdf/);
    expect(() => parseCompareArgs(["--pdf", "a.pdf", "--bogus"], { tmpRoot: "/scratch", now: new Date() })).toThrow(/--bogus/);
    expect(() => parseCompareArgs(["--pdf"], { tmpRoot: "/scratch", now: new Date() })).toThrow(/--pdf/);
  });

  test("parses --source and --document-type and validates the document type", () => {
    const now = { tmpRoot: "/scratch", now: new Date() };
    expect(parseCompareArgs(["--pdf", "a.pdf", "--source", "mirae-mf-2026-factsheets"], now).sourceKey)
      .toBe("mirae-mf-2026-factsheets");
    expect(parseCompareArgs(["--pdf", "a.pdf", "--document-type", "Factsheet"], now).documentType).toBe("Factsheet");
    expect(() => parseCompareArgs(["--pdf", "a.pdf", "--document-type", "Brochure"], now)).toThrow(/--document-type/);
    expect(() => parseCompareArgs(["--pdf", "a.pdf", "--document-type", "Factsheet", "--source", "x"], now))
      .toThrow(/--source.*--document-type|--document-type.*--source/);
  });
});

describe("resolveCompareDocumentType", () => {
  test("uses the scope source's declared document type, an explicit flag, or none", async () => {
    const manifest = parseAccessScopeManifestYaml(
      await Bun.file(join(repoRoot, "config/access-scopes/117-mirae-mf.yml")).text(),
      "117-mirae-mf.yml",
    );

    expect(resolveCompareDocumentType(manifest, { sourceKey: "mirae-mf-2026-factsheets", documentType: null }))
      .toBe("Factsheet");
    expect(resolveCompareDocumentType(manifest, { sourceKey: "mirae-mf-2026-addenda", documentType: null }))
      .toBeNull();
    expect(resolveCompareDocumentType(manifest, { sourceKey: null, documentType: "KIM" })).toBe("KIM");
    expect(resolveCompareDocumentType(manifest, { sourceKey: null, documentType: null })).toBeNull();
    expect(() => resolveCompareDocumentType(manifest, { sourceKey: "missing", documentType: null }))
      .toThrow(/missing/);
  });
});

import { describe, expect, test } from "bun:test";

import { PDFJS_VERSION, ReviewAssets } from "./assets.ts";

describe("review page view assets", () => {
  const assets = new ReviewAssets();

  test("pins the installed pdfjs-dist version in the asset URLs", async () => {
    const pkg = await Bun.file(Bun.resolveSync("pdfjs-dist/package.json", import.meta.dir)).json();
    const urls = await assets.urls();

    expect(PDFJS_VERSION).toBe(pkg.version);
    expect(urls.pdfjsUrl).toBe(`/review/assets/pdfjs/${PDFJS_VERSION}/pdf.min.mjs`);
    expect(urls.pdfjsWorkerUrl).toBe(`/review/assets/pdfjs/${PDFJS_VERSION}/pdf.worker.min.mjs`);
    expect(urls.clientUrl).toMatch(/^\/review\/assets\/page-view\.js\?v=[0-9a-f]{16}$/);
  });

  test("serves the allowlisted pdf.js files verbatim with a JS content type and immutable caching", async () => {
    for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
      const response = assets.pdfjsResponse(PDFJS_VERSION, file);
      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response?.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
      const expected = await Bun.file(Bun.resolveSync(`pdfjs-dist/build/${file}`, import.meta.dir)).text();
      expect(await response!.text()).toBe(expected);
    }
  });

  test("refuses files outside the allowlist and other versions", () => {
    for (const file of ["pdf.mjs", "pdf.sandbox.min.mjs", "../package.json", "..%2Fpackage.json", "pdf.min.mjs.map", ""]) {
      expect(assets.pdfjsResponse(PDFJS_VERSION, file)).toBeNull();
    }
    expect(assets.pdfjsResponse("1.0.0", "pdf.min.mjs")).toBeNull();
  });

  test("bundles the browser module once, without bundling pdf.js", async () => {
    const first = assets.clientBundle();
    const second = assets.clientBundle();
    expect(second).toBe(first);

    const bundle = await first;
    expect(bundle.code.length).toBeGreaterThan(500);
    expect(bundle.code).not.toContain("pdfjs-dist");
    expect(bundle.code).not.toContain("GlobalWorkerOptions={");
    expect(bundle.code).toContain("page-view-data");
    expect(bundle.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("serves the bundle with immutable caching only for the current hash", async () => {
    const { hash } = await assets.clientBundle();

    const current = await assets.clientResponse(hash);
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(current.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

    const stale = await assets.clientResponse("0000000000000000");
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe("no-cache");
  });
});

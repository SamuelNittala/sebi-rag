import { describe, expect, test } from "bun:test";

import { discoverMiraeMfSchemeSource, extractMiraeMfSchemePages } from "./mirae-mf.ts";

describe("Mirae MF scheme source", () => {
  test("keeps only unique scheme detail pages and fails closed on an incomplete index", () => {
    const links = Array.from({ length: 50 }, (_, index) => (
      `<a href="/mutual-fund-scheme/equity-fund/scheme-${index}">scheme</a>`
    )).join("");
    expect(extractMiraeMfSchemePages(`${links}<a href="/mutual-fund-scheme/equity-fund">category</a>${links}`))
      .toHaveLength(50);
    expect(() => extractMiraeMfSchemePages('<a href="/mutual-fund-scheme/equity-fund/one">one</a>'))
      .toThrow(/expected 50-100/);
  });

  test("adds the dated overview page before discovered scheme pages", async () => {
    const links = Array.from({ length: 50 }, (_, index) => (
      `<a href="/mutual-fund-scheme/debt-fund/scheme-${index}">scheme</a>`
    )).join("");
    const source = await discoverMiraeMfSchemeSource(async () => new Response(links));
    expect(source.name).toBe("mirae-mf-schemes");
    expect(source.pages).toHaveLength(51);
    expect(source.pages[0]).toMatchObject({ slug: "current-scheme-overview" });
  });
});

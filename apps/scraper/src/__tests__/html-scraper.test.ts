import { describe, test, expect } from "bun:test";
import { HtmlScraper } from "../html-scraper.ts";
import type { HtmlSourceConfig } from "../html-scraper.ts";

describe("HtmlScraper", () => {
  test("constructs with default options", () => {
    const scraper = new HtmlScraper();
    expect(scraper).toBeDefined();
  });

  test("constructs with custom output directory", () => {
    const scraper = new HtmlScraper({ outputDir: "/tmp/test-html-sources" });
    expect(scraper).toBeDefined();
  });

  test("source config type is valid", () => {
    const config: HtmlSourceConfig = {
      name: "test-source",
      contentCategory: "education",
      contentSelector: ".main-content",
      pages: [
        { url: "https://example.com/page1", slug: "page-one" },
        { url: "https://example.com/page2", slug: "page-two" },
      ],
      delayMs: 200,
    };

    expect(config.pages).toHaveLength(2);
    expect(config.contentCategory).toBe("education");
  });
});

describe("AMFI source configs", () => {
  test("knowledge centre has pages", async () => {
    const { amfiKnowledgeCentre } = await import("../sources/amfi.ts");

    expect(amfiKnowledgeCentre.name).toBe("amfi-knowledge-centre");
    expect(amfiKnowledgeCentre.contentCategory).toBe("education");
    expect(amfiKnowledgeCentre.pages.length).toBeGreaterThan(0);

    for (const page of amfiKnowledgeCentre.pages) {
      expect(page.url).toStartWith("https://");
      expect(page.slug).toBeTruthy();
    }
  });

  test("investor centre has pages", async () => {
    const { amfiInvestorCentre } = await import("../sources/amfi.ts");

    expect(amfiInvestorCentre.name).toBe("amfi-investor-centre");
    expect(amfiInvestorCentre.contentCategory).toBe("procedural");
    expect(amfiInvestorCentre.pages.length).toBeGreaterThan(0);
  });

  test("all sources export correctly", async () => {
    const { allAmfiSources } = await import("../sources/amfi.ts");

    expect(allAmfiSources).toHaveLength(2);
  });
});

describe("Mirae SIF source config", () => {
  test("includes the Platinum fund page and uses product content", async () => {
    const { miraeSifFund } = await import("../sources/mirae-sif.ts");

    expect(miraeSifFund.name).toBe("mirae-sif");
    expect(miraeSifFund.contentCategory).toBe("product");
    expect(miraeSifFund.pages).toEqual([
      {
        url: "https://platinumsif.miraeassetmf.co.in/fund?schemeCode=3166",
        slug: "platinum-hybrid-long-short-fund",
      },
    ]);
  });

  test("knowledge-center blogs are education content with explicit titles", async () => {
    const { miraeSifKnowledgeCenter } = await import("../sources/mirae-sif.ts");

    expect(miraeSifKnowledgeCenter.name).toBe("mirae-sif");
    expect(miraeSifKnowledgeCenter.contentCategory).toBe("education");
    expect(miraeSifKnowledgeCenter.pages).toHaveLength(6);
    for (const page of miraeSifKnowledgeCenter.pages) {
      expect(page.url.startsWith("https://platinumsif.miraeassetmf.co.in/knowledge-center/blogs/")).toBe(true);
      // SPA pages render h1/<title> as the site logo, so every blog needs an override
      expect(page.title?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("did-you-know accordion page is not configured (answers don't survive stream reassembly)", async () => {
    const { allMiraeSifSources } = await import("../sources/mirae-sif.ts");

    const allUrls = allMiraeSifSources.flatMap((s) => s.pages.map((p) => p.url));
    expect(allUrls.some((u) => u.includes("did-you-know"))).toBe(false);
  });
});

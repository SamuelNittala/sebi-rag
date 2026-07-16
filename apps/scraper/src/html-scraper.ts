/**
 * HTML Content Scraper
 *
 * Fetches HTML pages, extracts main content, converts to markdown,
 * and stores as .md files with frontmatter for later ingestion.
 */

import TurndownService from "turndown";
import { load as cheerioLoad } from "cheerio";
import { resolve, dirname } from "path";
import { mkdir } from "fs/promises";
import type { ContentCategory } from "@mf-rag/types";
import {
  extractMiraeSifFaqMarkdown,
  mergeMiraeSifFaqMarkdown,
} from "./mirae-sif-extractor.ts";

export interface HtmlSourceConfig {
  name: string;
  contentCategory: ContentCategory;
  contentSelector: string;
  pages: Array<{
    url: string;
    slug: string;
  }>;
  delayMs?: number;
}

export interface ScrapePageResult {
  url: string;
  slug: string;
  title: string;
  filePath: string;
  status: "ok" | "failed" | "skipped";
  error?: string;
}

export interface ScrapeSourceResult {
  source: string;
  pages: ScrapePageResult[];
  succeeded: number;
  failed: number;
}

const MIN_CONTENT_LENGTH = 100;

export class HtmlScraper {
  private lastRequestTime = 0;
  private delayMs: number;
  private turndown: TurndownService;
  private outputDir: string;

  constructor(options?: { outputDir?: string; delayMs?: number }) {
    this.outputDir = options?.outputDir ?? resolve(import.meta.dir, "../../..", "data/html-sources");
    this.delayMs = options?.delayMs ?? 500;

    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });

    // Strip images - keep alt text only
    this.turndown.addRule("images", {
      filter: "img",
      replacement: (_content, node) => {
        const el = node as HTMLElement;
        const alt = el.getAttribute("alt");
        return alt ? `[Image: ${alt}]` : "";
      },
    });

    // Strip iframes and scripts
    this.turndown.remove(["script", "style", "iframe", "noscript"]);
  }

  async scrapeSource(source: HtmlSourceConfig): Promise<ScrapeSourceResult> {
    const results: ScrapePageResult[] = [];
    let succeeded = 0;
    let failed = 0;

    const sourceDir = resolve(this.outputDir, source.name);
    await mkdir(sourceDir, { recursive: true });

    console.log(`Scraping ${source.pages.length} pages from ${source.name}...`);

    for (const page of source.pages) {
      try {
        const result = await this.scrapePage(page, source, sourceDir);
        results.push(result);

        if (result.status === "ok") {
          succeeded++;
          console.log(`  [ok] ${page.slug}`);
        } else if (result.status === "failed") {
          failed++;
          console.log(`  [FAIL] ${page.slug}: ${result.error}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failed++;
        results.push({
          url: page.url,
          slug: page.slug,
          title: "",
          filePath: "",
          status: "failed",
          error: msg,
        });
        console.log(`  [FAIL] ${page.slug}: ${msg}`);
      }
    }

    console.log(`Done: ${succeeded} ok, ${failed} failed\n`);

    return { source: source.name, pages: results, succeeded, failed };
  }

  private async scrapePage(
    page: { url: string; slug: string },
    source: HtmlSourceConfig,
    outputDir: string
  ): Promise<ScrapePageResult> {
    // Rate limit
    await this.rateLimit();

    // Fetch HTML
    const response = await this.fetchWithTimeout(page.url);
    if (!response.ok) {
      return {
        url: page.url,
        slug: page.slug,
        title: "",
        filePath: "",
        status: "failed",
        error: `HTTP ${response.status}`,
      };
    }

    const html = await response.text();

    // Extract content using cheerio
    const $ = cheerioLoad(html);

    // Remove navigation, footer, cookie banners, sidebars
    $("nav, footer, header, .cookie-banner, .sidebar, .menu, .breadcrumb, .social-share, .related-posts, .comments").remove();
    $('[role="navigation"], [role="banner"], [role="complementary"]').remove();

    // Extract title from h1 or <title>
    const title = $("h1").first().text().trim() || $("title").text().trim() || page.slug;

    // Try multiple selectors to find main content
    let contentHtml = "";
    const selectors = source.contentSelector.split(",").map((s) => s.trim());

    for (const selector of selectors) {
      const el = $(selector);
      if (el.length > 0 && el.text().trim().length > MIN_CONTENT_LENGTH) {
        contentHtml = el.html() || "";
        break;
      }
    }

    // Fallback: try common content wrappers
    if (!contentHtml || contentHtml.trim().length < MIN_CONTENT_LENGTH) {
      for (const fallback of ["main", "article", ".content", "#content", ".post-content", "body"]) {
        const el = $(fallback);
        if (el.length > 0 && el.text().trim().length > MIN_CONTENT_LENGTH) {
          contentHtml = el.html() || "";
          break;
        }
      }
    }

    if (!contentHtml || contentHtml.trim().length < MIN_CONTENT_LENGTH) {
      return {
        url: page.url,
        slug: page.slug,
        title,
        filePath: "",
        status: "failed",
        error: "No content extracted (below minimum length)",
      };
    }

    // Convert to markdown
    let markdown = this.turndown.turndown(contentHtml).trim();
    if (source.name === "mirae-sif") {
      const faqMarkdown = extractMiraeSifFaqMarkdown(html);
      if (faqMarkdown) {
        markdown = mergeMiraeSifFaqMarkdown(markdown, faqMarkdown);
      }
    }

    if (markdown.length < MIN_CONTENT_LENGTH) {
      return {
        url: page.url,
        slug: page.slug,
        title,
        filePath: "",
        status: "failed",
        error: "Markdown too short after conversion",
      };
    }

    // Build file with frontmatter
    const frontmatter = [
      "---",
      `title: "${title.replace(/"/g, '\\"')}"`,
      `source_url: "${page.url}"`,
      `content_category: ${source.contentCategory}`,
      `source: ${source.name}`,
      `scraped_at: "${new Date().toISOString()}"`,
      "---",
    ].join("\n");

    const fileContent = `${frontmatter}\n\n${markdown}\n`;

    // Write file
    const filePath = resolve(outputDir, `${page.slug}.md`);
    await Bun.write(filePath, fileContent);

    return {
      url: page.url,
      slug: page.slug,
      title,
      filePath,
      status: "ok",
    };
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private async fetchWithTimeout(url: string, timeoutMs = 15000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml,*/*",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

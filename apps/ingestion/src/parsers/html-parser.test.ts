import { describe, test, expect } from "bun:test";
import {
  parseFrontmatter,
  splitByHeadings,
  extractTables,
  parseHtmlMarkdown,
  toChunkInput,
} from "./html-parser.ts";

describe("parseFrontmatter", () => {
  test("parses valid YAML frontmatter", () => {
    const content = `---
title: "What is SIP?"
source_url: "https://example.com/sip"
content_category: education
source: amfi-knowledge-centre
scraped_at: "2026-03-22T10:00:00Z"
---

# What is SIP?

Content here.`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.title).toBe("What is SIP?");
    expect(frontmatter.source_url).toBe("https://example.com/sip");
    expect(frontmatter.content_category).toBe("education");
    expect(frontmatter.source).toBe("amfi-knowledge-centre");
    expect(body).toStartWith("# What is SIP?");
  });

  test("throws when no frontmatter present", () => {
    expect(() => parseFrontmatter("No frontmatter here")).toThrow("No frontmatter found");
  });
});

describe("splitByHeadings", () => {
  test("splits content at h2 boundaries", () => {
    const markdown = `# Main Title

Intro paragraph.

## Section One

First section content.

## Section Two

Second section content.`;

    const sections = splitByHeadings(markdown);

    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe("Main Title");
    expect(sections[0].text).toContain("Intro paragraph");
    expect(sections[1].heading).toBe("Section One");
    expect(sections[1].text).toContain("First section content");
    expect(sections[2].heading).toBe("Section Two");
    expect(sections[2].text).toContain("Second section content");
  });

  test("handles content with no h2 headings", () => {
    const markdown = "Just plain content with no headings.";

    const sections = splitByHeadings(markdown);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBeNull();
    expect(sections[0].text).toBe("Just plain content with no headings.");
  });

  test("handles content starting with h2 (no preamble)", () => {
    const markdown = `## First Section

Content here.

## Second Section

More content.`;

    const sections = splitByHeadings(markdown);

    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("First Section");
    expect(sections[1].heading).toBe("Second Section");
  });
});

describe("extractTables", () => {
  test("extracts markdown tables from text", () => {
    const text = `Some text before.

| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |
| Cell 3 | Cell 4 |

Some text after.`;

    const { textWithoutTables, tables } = extractTables(text);

    expect(tables).toHaveLength(1);
    expect(tables[0]).toContain("Header 1");
    expect(textWithoutTables).toContain("Some text before");
    expect(textWithoutTables).toContain("Some text after");
  });

  test("returns empty tables for text without tables", () => {
    const text = "No tables here, just plain text.";
    const { textWithoutTables, tables } = extractTables(text);

    expect(tables).toHaveLength(0);
    expect(textWithoutTables).toBe(text);
  });
});

describe("parseHtmlMarkdown", () => {
  test("parses complete markdown document", () => {
    const content = `---
title: "Test Doc"
source_url: "https://example.com/test"
content_category: procedural
source: test-source
scraped_at: "2026-03-22T10:00:00Z"
---

# Test Document

Introduction text.

## How To Do It

Step 1. Do this thing.

## Important Notes

Note about something.`;

    const parsed = parseHtmlMarkdown(content);

    expect(parsed.frontmatter.title).toBe("Test Doc");
    expect(parsed.frontmatter.content_category).toBe("procedural");
    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections[0].sectionIndex).toBe(0);
    expect(parsed.sections[1].heading).toBe("How To Do It");
    expect(parsed.rawText).toContain("Introduction text");
  });
});

describe("toChunkInput", () => {
  test("converts parsed document to ChunkInput", () => {
    const content = `---
title: "Test"
source_url: "https://example.com"
content_category: education
source: test
scraped_at: "2026-03-22T10:00:00Z"
---

# Title

Intro text.

## Section One

Content with a table.

| A | B |
| --- | --- |
| 1 | 2 |

## Section Two

More content.`;

    const parsed = parseHtmlMarkdown(content);
    const input = toChunkInput(parsed);

    expect(input.pages.length).toBeGreaterThanOrEqual(2);
    // Tables should be extracted
    expect(input.tables).toBeDefined();
    expect(input.tables!.length).toBe(1);
  });

  test("handles document with no tables", () => {
    const content = `---
title: "Simple"
source_url: "https://example.com"
content_category: education
source: test
scraped_at: "2026-03-22T10:00:00Z"
---

# Simple Doc

Just text, no tables.`;

    const parsed = parseHtmlMarkdown(content);
    const input = toChunkInput(parsed);

    expect(input.pages.length).toBe(1);
    expect(input.tables).toBeUndefined();
  });
});

import { test, expect, describe } from "bun:test";
import { parseAmcList, parseSchemeList, parsePdfUrl } from "../parser";
import type { AMC, Scheme } from "../types";

describe("AMC List Parser", () => {
  test("parses valid AMC list HTML", () => {
    const html = `
      <table class="mfClass">
        <tr>
          <td><a href="javascript:viewMF('MF001')">Aditya Birla Sun Life AMC Limited</a></td>
        </tr>
        <tr>
          <td><a href="javascript:viewMF('MF002')">Axis Asset Management Company Ltd</a></td>
        </tr>
        <tr>
          <td><a href="javascript:viewMF('MF003')">Bandhan AMC Limited</a></td>
        </tr>
      </table>
    `;

    const result = parseAmcList(html);

    expect(result.amcs).toHaveLength(3);
    expect(result.amcs[0]).toEqual({
      sebiId: "MF001",
      name: "Aditya Birla Sun Life AMC Limited",
    });
    expect(result.amcs[1]).toEqual({
      sebiId: "MF002",
      name: "Axis Asset Management Company Ltd",
    });
    expect(result.errors).toHaveLength(0);
  });

  test("handles empty table", () => {
    const html = `<table class="mfClass"></table>`;

    const result = parseAmcList(html);

    expect(result.amcs).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("handles malformed HTML gracefully", () => {
    const html = `<div>not a table</div>`;

    const result = parseAmcList(html);

    expect(result.amcs).toHaveLength(0);
    // Should not throw, just return empty
  });

  test("extracts SEBI ID from various javascript patterns", () => {
    const html = `
      <table class="mfClass">
        <tr><td><a href="javascript:viewMF('MF001')">AMC 1</a></td></tr>
        <tr><td><a href="javascript:viewMF(&quot;MF002&quot;)">AMC 2</a></td></tr>
        <tr><td><a onclick="viewMF('MF003')">AMC 3</a></td></tr>
      </table>
    `;

    const result = parseAmcList(html);

    expect(result.amcs).toHaveLength(3);
    expect(result.amcs.map((a) => a.sebiId)).toEqual(["MF001", "MF002", "MF003"]);
  });

  test("trims whitespace from names", () => {
    const html = `
      <table class="mfClass">
        <tr><td><a href="javascript:viewMF('MF001')">  Trimmed Name  </a></td></tr>
      </table>
    `;

    const result = parseAmcList(html);

    expect(result.amcs[0].name).toBe("Trimmed Name");
  });

  test("skips rows without valid SEBI ID", () => {
    const html = `
      <table class="mfClass">
        <tr><td><a href="javascript:viewMF('MF001')">Valid AMC</a></td></tr>
        <tr><td><a href="#">Invalid Link</a></td></tr>
        <tr><td>Just text</td></tr>
      </table>
    `;

    const result = parseAmcList(html);

    expect(result.amcs).toHaveLength(1);
    expect(result.amcs[0].sebiId).toBe("MF001");
  });
});

describe("Scheme List Parser", () => {
  test("parses valid scheme list HTML", () => {
    const html = `
      <table class="schemeClass">
        <tr>
          <td><a href="javascript:viewScheme('SCH001')">Aditya Birla Sun Life Equity Fund - Growth</a></td>
        </tr>
        <tr>
          <td><a href="javascript:viewScheme('SCH002')">Aditya Birla Sun Life Liquid Fund - Direct</a></td>
        </tr>
      </table>
    `;
    const amcId = "MF001";
    const amcName = "Aditya Birla Sun Life AMC Limited";

    const result = parseSchemeList(html, amcId, amcName);

    expect(result.schemes).toHaveLength(2);
    expect(result.schemes[0]).toEqual({
      sebiSchemeId: "SCH001",
      sebiFundId: "MF001",
      name: "Aditya Birla Sun Life Equity Fund - Growth",
      amcName: "Aditya Birla Sun Life AMC Limited",
    });
    expect(result.errors).toHaveLength(0);
  });

  test("associates correct AMC info with schemes", () => {
    const html = `
      <table class="schemeClass">
        <tr><td><a href="javascript:viewScheme('SCH001')">Test Scheme</a></td></tr>
      </table>
    `;

    const result = parseSchemeList(html, "MF999", "Custom AMC Name");

    expect(result.schemes[0].sebiFundId).toBe("MF999");
    expect(result.schemes[0].amcName).toBe("Custom AMC Name");
  });

  test("handles empty scheme list", () => {
    const html = `<table class="schemeClass"></table>`;

    const result = parseSchemeList(html, "MF001", "Test AMC");

    expect(result.schemes).toHaveLength(0);
  });

  test("extracts scheme ID from various patterns", () => {
    const html = `
      <table class="schemeClass">
        <tr><td><a href="javascript:viewScheme('SCH001')">Scheme 1</a></td></tr>
        <tr><td><a onclick="viewScheme('SCH002')">Scheme 2</a></td></tr>
        <tr><td><a href="javascript:void(0)" onclick="viewScheme('SCH003')">Scheme 3</a></td></tr>
      </table>
    `;

    const result = parseSchemeList(html, "MF001", "Test AMC");

    expect(result.schemes.map((s) => s.sebiSchemeId)).toEqual([
      "SCH001",
      "SCH002",
      "SCH003",
    ]);
  });
});

describe("PDF URL Parser", () => {
  test("extracts PDF URL from iframe src", () => {
    const html = `
      <html>
        <body>
          <iframe src="https://www.sebi.gov.in/sebi_data/mutualfundfile/jan-2026/sample_document.pdf"></iframe>
        </body>
      </html>
    `;

    const result = parsePdfUrl(html);

    expect(result.url).toBe(
      "https://www.sebi.gov.in/sebi_data/mutualfundfile/jan-2026/sample_document.pdf"
    );
    expect(result.error).toBeUndefined();
  });

  test("extracts PDF URL from relative iframe src", () => {
    const html = `
      <html>
        <body>
          <iframe src="/sebi_data/mutualfundfile/jan-2026/sample.pdf"></iframe>
        </body>
      </html>
    `;

    const result = parsePdfUrl(html);

    expect(result.url).toBe(
      "https://www.sebi.gov.in/sebi_data/mutualfundfile/jan-2026/sample.pdf"
    );
  });

  test("returns null when no iframe present", () => {
    const html = `<html><body><p>No iframe here</p></body></html>`;

    const result = parsePdfUrl(html);

    expect(result.url).toBeNull();
  });

  test("returns null when iframe has no PDF src", () => {
    const html = `
      <html>
        <body>
          <iframe src="https://example.com/page.html"></iframe>
        </body>
      </html>
    `;

    const result = parsePdfUrl(html);

    expect(result.url).toBeNull();
  });

  test("handles multiple iframes, finds PDF one", () => {
    const html = `
      <html>
        <body>
          <iframe src="https://example.com/ad.html"></iframe>
          <iframe src="https://www.sebi.gov.in/sebi_data/mutualfundfile/jan-2026/fund.pdf"></iframe>
          <iframe src="https://example.com/tracker.html"></iframe>
        </body>
      </html>
    `;

    const result = parsePdfUrl(html);

    expect(result.url).toBe(
      "https://www.sebi.gov.in/sebi_data/mutualfundfile/jan-2026/fund.pdf"
    );
  });

  test("extracts URL with various date formats", () => {
    const testCases = [
      "jan-2026",
      "feb-2025",
      "mar-2024",
      "december-2023",
      "01-2026",
      "12-2025",
    ];

    for (const dateFormat of testCases) {
      const html = `<iframe src="https://www.sebi.gov.in/sebi_data/mutualfundfile/${dateFormat}/doc.pdf"></iframe>`;
      const result = parsePdfUrl(html);
      expect(result.url).toContain(dateFormat);
    }
  });
});

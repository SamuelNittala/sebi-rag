import { describe, expect, test } from "bun:test";

import { buildCurrentTerMarkdown } from "./mirae-mf-ter.ts";

describe("Mirae MF TER conversion", () => {
  test("keeps only the latest row for each scheme and labels its authority date", () => {
    const header = "code,name,date,a,b,c,d,regular,e,f,g,h,direct\nsubheader,,,,,,,,,,,,\n";
    const old = "code-0,Scheme 0,08/15/2026,1%,0,0,0,1%,0.5%,0,0,0,0.5%\n";
    const current = Array.from({ length: 50 }, (_, index) => (
      `code-${index},Scheme ${index},08/16/2026,1%,0,0,0,1.2%,0.5%,0,0,0,0.7%`
    )).join("\n");
    const result = buildCurrentTerMarkdown(header + old + current, "https://example.com/current.xls", "2026-08-17T00:00:00.000Z");
    expect(result.asOf).toBe("2026-08-16");
    expect(result.schemeCount).toBe(50);
    expect(result.markdown).toContain("source_date: \"2026-08-16\"");
    expect(result.markdown).toContain("Regular Plan total expense ratio (TER): 1.2%");
    expect(result.markdown).not.toContain("08/15/2026");
  });
});

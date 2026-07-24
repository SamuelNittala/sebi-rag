import { describe, expect, test } from "bun:test";

import { parseSourceUrlOption } from "./cli-options.ts";

describe("parseSourceUrlOption", () => {
  test("normalizes an absolute HTTPS URL", () => {
    expect(parseSourceUrlOption([
      "document.pdf",
      "--source-url",
      "https://example.com/addendum.pdf",
    ])).toBe("https://example.com/addendum.pdf");
  });

  test("rejects missing, flag-shaped, and non-HTTP values", () => {
    expect(() => parseSourceUrlOption(["document.pdf", "--source-url"])).toThrow();
    expect(() => parseSourceUrlOption([
      "document.pdf",
      "--source-url",
      "--review-existing",
    ])).toThrow();
    expect(() => parseSourceUrlOption([
      "document.pdf",
      "--source-url",
      "/tmp/addendum.pdf",
    ])).toThrow();
  });
});

import { describe, expect, test } from "bun:test";

import { resolveDenseScoreThreshold } from "./retrieval-config.ts";

describe("resolveDenseScoreThreshold", () => {
  test("defaults to 0.3 when no override is configured", () => {
    expect(resolveDenseScoreThreshold(undefined)).toBe(0.3);
  });

  test("accepts a configured similarity threshold", () => {
    expect(resolveDenseScoreThreshold("0.4")).toBe(0.4);
  });

  test.each(["", "invalid", "-0.1", "1.1"])(
    "falls back to 0.3 for %s",
    (value) => {
      expect(resolveDenseScoreThreshold(value)).toBe(0.3);
    },
  );
});

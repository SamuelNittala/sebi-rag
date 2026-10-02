import { describe, expect, test } from "bun:test";

import { assertDoclingParseResponse } from "./docling-contract.ts";

const GOLDEN_URL = new URL("../../../../tests/fixtures/docling/mirae-flexi-cap-p34-35.wire.json", import.meta.url);

describe("Docling golden wire fixture", () => {
  test("the Python normalizer golden satisfies the TS contract validator", async () => {
    const golden: unknown = await Bun.file(GOLDEN_URL).json();
    expect(() => assertDoclingParseResponse(golden)).not.toThrow();
  });
});

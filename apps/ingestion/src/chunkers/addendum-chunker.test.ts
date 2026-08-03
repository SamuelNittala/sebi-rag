import { describe, expect, test } from "bun:test";

import { chunkAddendum } from "./addendum-chunker.ts";

const pages = [
  {
    pageNumber: 1,
    text: `
      NOTICE CUM ADDENDUM NO. SIF/05/2026
      NOTICE-CUM-ADDENDUM TO THE SAI, ISID AND KIM OF PLATINUM HYBRID LONG-SHORT FUND
      The features shall stand modified with effect from Wednesday, July 01, 2026.
      Particulars Existing Provisions Proposed Provisions
      Minimum Application Amount/switch in
      Minimum amount for accredited investor: Rs. 5,00,000 and in multiples of Re. 1,000 thereafter.
      Minimum amount for accredited investor: Rs. 1,00,000 and in multiples of Re. 1,000 thereafter.
      • Systematic Investment Plan
      Monthly and Quarterly Systematic Investment Plan with a minimum amount of Rs. 50,000 and minimum of 5 instalments.
      • Systematic Withdrawal Plan
      Investors can withdraw for a minimum of Rs. 50,000 and in multiples of Re. 1 thereafter.
      • Systematic Investment Plan
      Monthly and Quarterly Systematic Investment Plan with a minimum amount of Rs. 5,000 and in multiples of Re. 1 thereafter,
      with a minimum of 5 instalments. The minimum investment should be Rs. 10,00,000 across all strategies and for
      accredited investor it should be at least Rs. 1,00,000 in Platinum Hybrid Long-Short Fund.
    `,
  },
  {
    pageNumber: 2,
    text: `
      The existing SWP minimum balance for accredited investor should be at least Rs. 5,00,000 in the fund.
      • Systematic Withdrawal Plan
      Investors can withdraw for a minimum of Rs. 5,000 and in multiples of Re. 1 thereafter.
      For SWP, the minimum investment after withdrawal should be Rs. 10,00,000 across all strategies and for
      accredited investor it should be at least Rs. 1,00,000 in Platinum Hybrid Long-Short Fund.
      Exit Load: If redeemed within 90 days from the date of allotment: 1%. If redeemed after 90 days: NIL.
      Exit Load: If redeemed within 30 days from the date of allotment: 1%. If redeemed after 30 days: NIL.
      This Notice-cum-Addendum forms an integral part of the ISID, KIM and SAI.
      All other terms and conditions remain unchanged.
      DATE: June 29, 2026
    `,
  },
];

describe("chunkAddendum", () => {
  test("creates unambiguous effective-dated amendment chunks", () => {
    const result = chunkAddendum({
      pages,
      fundName: "Platinum Hybrid Long-Short Fund",
      amendmentNumber: "SIF/05/2026",
      effectiveDate: "2026-07-01",
      amendedDocumentTypes: ["SAI", "ISID", "KIM"],
    });

    expect(result).not.toBeNull();
    expect(result?.chunks.map((chunk) => chunk.sectionHeader)).toEqual([
      "Addendum scope",
      "Minimum application amount",
      "Systematic Investment Plan",
      "Systematic Withdrawal Plan",
      "Exit Load",
    ]);
    expect(result?.chunks[1]?.text).toContain("from 2026-07-01: Rs. 1,00,000");
    expect(result?.chunks[1]?.text).toContain("supersedes the prior provision of Rs. 5,00,000");
    expect(result?.chunks[2]?.text).toContain("from 2026-07-01: Rs. 5,000");
    expect(result?.chunks[2]?.text).toContain("minimum number of SIP installments remains 5");
    expect(result?.chunks[3]?.text).toContain("from 2026-07-01: Rs. 5,000");
    expect(result?.chunks[4]?.text).toContain("within 30 days");
    expect(result?.chunks[4]?.text).toContain("supersedes the prior 90-day window");
    expect(result?.chunks.every((chunk) => !chunk.hasTable)).toBe(true);
  });

  test("returns null when the document does not contain paired amendment facts", () => {
    expect(chunkAddendum({
      pages: [{ pageNumber: 1, text: "A general notice without amended provisions." }],
      fundName: "Example Fund",
      amendmentNumber: "01/2026",
      effectiveDate: "2026-07-01",
      amendedDocumentTypes: [],
    })).toBeNull();
  });

  test("returns null rather than guessing when an amendment has an extra matching value", () => {
    const ambiguousPages = pages.map((page, index) => index === 0
      ? {
          ...page,
          text: page.text.replace(
            "Minimum amount for accredited investor: Rs. 1,00,000",
            "Minimum amount for accredited investor: Rs. 2,00,000\n"
              + "Minimum amount for accredited investor: Rs. 1,00,000",
          ),
        }
      : page);

    expect(chunkAddendum({
      pages: ambiguousPages,
      fundName: "Platinum Hybrid Long-Short Fund",
      amendmentNumber: "SIF/05/2026",
      effectiveDate: "2026-07-01",
      amendedDocumentTypes: ["SAI", "ISID", "KIM"],
    })).toBeNull();
  });
});

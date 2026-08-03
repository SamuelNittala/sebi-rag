import { describe, expect, test } from "bun:test";

import type { HybridRetrievalCandidate } from "./hybrid-retrieval-contracts.ts";
import {
  fuseHybridCandidates,
  resolveRetrievalIntent,
} from "./hybrid-retrieval.ts";

interface Candidate extends HybridRetrievalCandidate {
  text: string;
}

function candidate(
  id: string,
  text: string,
  metadata: HybridRetrievalCandidate["metadata"] = null,
  sourceType: Candidate["sourceType"] = "scheme_document",
): Candidate {
  return { id, sourceType, text, metadata };
}

describe("hybrid retrieval intent", () => {
  test("identifies strategy-manager intent for Platinum SIF", () => {
    expect(resolveRetrievalIntent("Who is the fund manager for Platinum SIF?")).toEqual({
      factType: "fund_manager",
      strategyId: "platinum-hybrid-long-short-fund",
      preferredDocumentScope: "strategy",
    });
  });

  test("identifies investment-objective intent", () => {
    expect(resolveRetrievalIntent("What is the investment objective for Platinum SIF?")).toMatchObject({
      factType: "investment_objective",
      preferredDocumentScope: "strategy",
    });
  });

  test("identifies colloquial early-exit questions as exit-load intent", () => {
    expect(resolveRetrievalIntent("how much do I pay if I exit early")).toMatchObject({
      factType: "exit_load",
      supersessionKey: "exit_load_window",
    });
  });

  test("identifies colloquial accredited-investor minimum questions", () => {
    expect(
      resolveRetrievalIntent(
        "what is the minimum amount to invest for accredited investors in platinum sif?",
      ),
    ).toEqual({
      factType: "minimum_investment",
      strategyId: "platinum-hybrid-long-short-fund",
      preferredDocumentScope: "strategy",
      supersessionKey: "accredited_minimum_application",
    });
  });

  test("limits supersession to the amended sub-fact", () => {
    expect(resolveRetrievalIntent("What is the minimum SIP installment amount?"))
      .toMatchObject({ supersessionKey: "minimum_sip_installment" });
    expect(resolveRetrievalIntent("What SWP frequencies can I choose?").supersessionKey)
      .toBeUndefined();
    expect(resolveRetrievalIntent("When can I redeem in Platinum SIF?").supersessionKey)
      .toBeUndefined();
  });

  test("keeps multi-fact Platinum questions strategy-scoped without choosing one fact", () => {
    expect(
      resolveRetrievalIntent(
        "What are the minimum investment and redemption terms for Platinum SIF?",
      ),
    ).toEqual({
      factType: null,
      strategyId: "platinum-hybrid-long-short-fund",
      preferredDocumentScope: "strategy",
    });
  });

  test("recognizes ampersands between coordinated fact requests", () => {
    expect(
      resolveRetrievalIntent(
        "What are the minimum investment & redemption terms for Platinum SIF?",
      ),
    ).toEqual({
      factType: null,
      strategyId: "platinum-hybrid-long-short-fund",
      preferredDocumentScope: "strategy",
    });
  });

  test("keeps manager precedence when one request contains overlapping fact language", () => {
    expect(
      resolveRetrievalIntent("Who manages the investment strategy for Platinum SIF?"),
    ).toEqual({
      factType: "fund_manager",
      strategyId: "platinum-hybrid-long-short-fund",
      preferredDocumentScope: "strategy",
    });
  });

  test("keeps a generic SIF definition at umbrella scope", () => {
    expect(resolveRetrievalIntent("What is a Specialized Investment Fund?")).toEqual({
      factType: null,
      strategyId: null,
      preferredDocumentScope: "sif_umbrella",
    });
  });

  test("keeps the plural SIFs form at umbrella scope", () => {
    expect(resolveRetrievalIntent("Explain SIFs").preferredDocumentScope)
      .toBe("sif_umbrella");
  });
});

describe("reciprocal-rank fusion", () => {
  test("prefers evidence found by both retrievers without adding raw scores", () => {
    const shared = candidate("shared", "Investment objective");
    const denseOnly = candidate("dense", "Semantic result");
    const lexicalOnly = candidate("lexical", "Exact words");
    const result = fuseHybridCandidates({
      dense: [
        { candidate: denseOnly, score: 0.99 },
        { candidate: shared, score: 0.61 },
      ],
      lexical: [
        { candidate: lexicalOnly, score: 1000 },
        { candidate: shared, score: 0.01 },
      ],
      intent: resolveRetrievalIntent("ordinary query"),
      limit: 3,
    });

    expect(result[0]?.candidate.id).toBe("shared");
    expect(result.find((item) => item.candidate.id === "lexical")?.trace.denseRank).toBeNull();
    expect(result[0]?.trace).toMatchObject({ denseRank: 2, lexicalRank: 2 });
  });

  test("keeps equal UUIDs from different source families distinct", () => {
    const result = fuseHybridCandidates({
      dense: [{ candidate: candidate("same", "PDF"), score: 0.8 }],
      lexical: [{
        candidate: candidate("same", "HTML", null, "knowledge_base"),
        score: 4,
      }],
      intent: resolveRetrievalIntent("ordinary query"),
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });
});

describe("reviewed metadata ranking", () => {
  test("filters the superseded plural accredited-investor minimum", () => {
    const previousPlainText = candidate(
      "previous-plain-text",
      "For accredited investors, the minimum investment is Rs. 5,00,000.",
      {
        documentScope: "strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        factType: "minimum_investment",
        documentType: "ISID",
      },
    );
    const previousTable = candidate(
      "previous-table",
      [
        "| However, the | minimum applicati | on amount fo | r accredited |",
        "| investors shall | be Rs. 5,00,000/- an | d in multiples o | f Rs. 1,000/- |",
      ].join("\n"),
      {
        documentScope: "strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        documentType: "ISID",
      },
    );
    const previousDenseTable = candidate(
      "previous-dense-table",
      [
        "| thereafter. | | accredite | d | | units requested |",
        "| | | | | investors | , | the | investor |",
        "| | | Minimum | amount | minimum for | | | redemption |",
        "| | | accredited | investor ( | additional | amount Rs. | |",
        "| | | Rs. 5,00,000 an | d in multiple | s of 1,000/- | thereafter. |",
      ].join("\n"),
      {
        documentScope: "strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        documentType: "KIM",
      },
    );
    const addendum = candidate(
      "addendum",
      "For accredited investors, the minimum application amount is Rs. 1,00,000.",
      {
        documentScope: "strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        factType: "minimum_investment",
        documentType: "Addendum",
        effectiveDate: "2026-07-01",
        supersessionKey: "accredited_minimum_application",
      },
    );
    const result = fuseHybridCandidates({
      dense: [
        { candidate: previousPlainText, score: 0.95 },
        { candidate: previousTable, score: 0.9 },
        { candidate: previousDenseTable, score: 0.85 },
        { candidate: addendum, score: 0.8 },
      ],
      lexical: [
        { candidate: previousPlainText, score: 9.5 },
        { candidate: previousTable, score: 9 },
        { candidate: previousDenseTable, score: 8.5 },
        { candidate: addendum, score: 8 },
      ],
      intent: resolveRetrievalIntent(
        "what is the minimum amount to invest for accredited investors in platinum sif?",
      ),
      limit: 2,
      asOfDate: "2026-07-23",
    });

    expect(result.map((item) => item.candidate.id)).toEqual(["addendum"]);
  });

  test("prefers an effective addendum over the provision it supersedes", () => {
    const previous = candidate("previous", "Minimum SIP amount is Rs. 50,000.", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      factType: "minimum_investment",
      documentType: "ISID",
    });
    const addendum = candidate("addendum", "From 2026-07-01 the minimum SIP amount is Rs. 5,000.", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      factType: "minimum_investment",
      documentType: "Addendum",
      effectiveDate: "2026-07-01",
      amendmentNumber: "SIF/05/2026",
      supersessionKey: "minimum_sip_installment",
    });
    const result = fuseHybridCandidates({
      dense: [
        { candidate: previous, score: 0.9 },
        { candidate: addendum, score: 0.8 },
      ],
      lexical: [
        { candidate: previous, score: 9 },
        { candidate: addendum, score: 8 },
      ],
      intent: resolveRetrievalIntent("What is the minimum SIP installment amount?"),
      limit: 2,
      asOfDate: "2026-07-23",
    });

    expect(result[0]?.candidate.id).toBe("addendum");
    expect(result[0]?.trace.metadataSignals).toContain("temporal:effective_addendum");
    expect(result.some((item) => item.candidate.id === "previous")).toBe(false);
  });

  test("filters superseded legacy chunks using their Platinum document identity", () => {
    const previous = {
      ...candidate("previous", [
        "[TABLE]",
        "| Type of Load | Load chargeable (as %age of NAV) |",
        "| Exit | If redeemed within 90 days: 1% |",
      ].join("\n"), {
        documentScope: "strategy" as const,
        factType: "exit_load",
        documentType: "ISID",
      }),
      fundName: "I Platinum Hybrid Long Short Fund",
    };
    const addendum = candidate(
      "addendum",
      "Current exit load is 1% within 30 days; NIL afterward.",
      {
        documentScope: "strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        factType: "exit_load",
        documentType: "Addendum",
        effectiveDate: "2026-07-01",
        supersessionKey: "exit_load_window",
      },
    );

    const result = fuseHybridCandidates({
      dense: [
        { candidate: previous, score: 0.9 },
        { candidate: addendum, score: 0.8 },
      ],
      lexical: [
        { candidate: previous, score: 9 },
        { candidate: addendum, score: 8 },
      ],
      intent: resolveRetrievalIntent("how much do I pay if I exit early"),
      limit: 2,
      asOfDate: "2026-07-23",
    });

    expect(result.map((item) => item.candidate.id)).toEqual(["addendum"]);
  });

  test("does not promote an addendum before its effective date", () => {
    const previous = candidate("previous", "Minimum SIP amount is Rs. 50,000.", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      factType: "minimum_investment",
      documentType: "ISID",
    });
    const addendum = candidate("addendum", "From 2026-07-01 the minimum SIP amount is Rs. 5,000.", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      factType: "minimum_investment",
      documentType: "Addendum",
      effectiveDate: "2026-07-01",
      supersessionKey: "minimum_sip_installment",
    });
    const result = fuseHybridCandidates({
      dense: [
        { candidate: previous, score: 0.9 },
        { candidate: addendum, score: 0.8 },
      ],
      lexical: [
        { candidate: previous, score: 9 },
        { candidate: addendum, score: 8 },
      ],
      intent: resolveRetrievalIntent("What is the minimum SIP installment amount?"),
      limit: 2,
      asOfDate: "2026-06-30",
    });

    expect(result[0]?.candidate.id).toBe("previous");
    expect(result[1]?.trace.metadataSignals).not.toContain("temporal:effective_addendum");
  });

  test("does not promote a minimum-SWP amendment for an unaffected frequency query", () => {
    const addendum = candidate("addendum", "Current minimum SWP withdrawal is Rs. 5,000.", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      factType: "redemption",
      documentType: "Addendum",
      effectiveDate: "2026-07-01",
      supersessionKey: "minimum_swp_withdrawal",
    });
    const result = fuseHybridCandidates({
      dense: [{ candidate: addendum, score: 0.9 }],
      lexical: [{ candidate: addendum, score: 9 }],
      intent: resolveRetrievalIntent("What SWP frequencies can I choose?"),
      limit: 1,
      asOfDate: "2026-07-23",
    });

    expect(result[0]?.trace.metadataSignals).not.toContain("temporal:effective_addendum");
  });

  test("ranks Gaurik's strategy assignment above an SAI staff directory", () => {
    const gaurik = candidate("gaurik", "Mr. Gaurik Shah", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "strategy_management",
      factType: "fund_manager",
      sourceAuthority: "regulatory_filing",
      classificationSource: "exact_heading",
      confidence: 1,
    });
    const staff = candidate("staff", "Mr. Akshay Udeshi", {
      documentScope: "sif_umbrella",
      strategyId: null,
      sectionType: "staff_directory",
      factType: null,
      sourceAuthority: "regulatory_filing",
    });
    const result = fuseHybridCandidates({
      dense: [
        { candidate: staff, score: 0.8 },
        { candidate: gaurik, score: 0.7 },
      ],
      lexical: [],
      intent: resolveRetrievalIntent("Who is the fund manager for Platinum SIF?"),
      limit: 2,
    });

    expect(result[0]?.candidate.id).toBe("gaurik");
    expect(result[0]?.trace.metadataSignals).toContain("fact_type:fund_manager");
    expect(result[0]?.trace.metadataSignals).toContain("classification:exact_heading");
    expect(result[0]?.trace.finalScore).toBeGreaterThan(1);
    expect(result[1]?.trace.metadataSignals).toContain("penalty:staff_directory");
  });

  test("promotes reviewed investment-objective evidence into the top three", () => {
    const dense = Array.from({ length: 10 }, (_, index) => ({
      candidate: candidate(`generic-${index}`, `Generic result ${index}`, {
        documentScope: "strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        sectionType: "overview",
        factType: null,
      }),
      score: 0.9 - index * 0.01,
    }));
    const objective = candidate("objective", "The investment objective is...", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "investment_objective",
      factType: "investment_objective",
      sourceAuthority: "regulatory_filing",
      classificationSource: "exact_heading",
      confidence: 1,
    });
    dense.push({ candidate: objective, score: 0.79 });

    const result = fuseHybridCandidates({
      dense,
      lexical: [{ candidate: objective, score: 8 }],
      intent: resolveRetrievalIntent("What is the investment objective for Platinum SIF?"),
      limit: 10,
    });

    expect(result.findIndex((item) => item.candidate.id === "objective")).toBeLessThan(3);
  });

  test("does not let a fact mismatch erase strong multi-fact retrieval evidence", () => {
    const mixedSection = candidate("mixed", "Redemption and exit load details", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "exit_load",
      factType: "exit_load",
      sourceAuthority: "regulatory_filing",
    });
    const fillers = Array.from(
      { length: 3 },
      (_, index) => candidate(`filler-${index}`, `Generic result ${index}`),
    );
    const unlabeled = candidate("unlabeled", "Generic unlabeled result");
    const rankedCandidates = [mixedSection, ...fillers, unlabeled]
      .map((item, index) => ({ candidate: item, score: 1 - index * 0.01 }));

    const result = fuseHybridCandidates({
      dense: rankedCandidates,
      lexical: rankedCandidates,
      intent: resolveRetrievalIntent("When can I redeem in Platinum SIF?"),
      limit: 5,
    });

    expect(result.findIndex((item) => item.candidate.id === "mixed"))
      .toBeLessThan(result.findIndex((item) => item.candidate.id === "unlabeled"));
  });

  test("keeps candidates with missing metadata and records no adjustment", () => {
    const result = fuseHybridCandidates({
      dense: [{ candidate: candidate("plain", "Fallback"), score: 0.7 }],
      lexical: [],
      intent: resolveRetrievalIntent("What is the exit load?"),
      limit: 1,
    });

    expect(result[0]?.candidate.id).toBe("plain");
    expect(result[0]?.trace.metadataAdjustment).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";

import { ChunkInspector } from "./index.ts";
import type { InspectionCandidate, InspectionInput } from "./types.ts";

function candidate(
  chunkIndex: number,
  text: string,
  overrides: Partial<InspectionCandidate> = {},
): InspectionCandidate {
  return {
    id: `candidate-${chunkIndex}`,
    chunkIndex,
    text,
    pageNumbers: [chunkIndex + 1],
    tokenCount: Math.max(1, text.trim().split(/\s+/).length),
    hasTable: false,
    sectionHeader: null,
    metadata: { documentScope: "strategy", documentType: "ISID" },
    ...overrides,
  };
}

function input(candidates: InspectionCandidate[]): InspectionInput {
  return {
    document: { id: "document-1", filename: "example.pdf", pageCount: 20 },
    candidates,
  };
}

describe("ChunkInspector", () => {
  test("inspects every candidate even when no findings exist", () => {
    const candidates = [
      candidate(0, "The investment strategy seeks long-term capital appreciation through a diversified portfolio."),
      candidate(1, "Redemption requests are processed according to the interval rules stated in the document."),
    ];

    const report = new ChunkInspector().inspect(input(candidates));

    expect(report.candidateChunkCount).toBe(2);
    expect(report.inspectedChunkCount).toBe(2);
    expect(report.findings).toEqual([]);
  });

  test("blocks an empty candidate", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "   ", { tokenCount: 0 }),
    ]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      candidateId: "candidate-0",
      ruleCode: "EMPTY_CHUNK",
      severity: "critical",
      blocksApproval: true,
    }));
  });

  test("blocks a document with no candidate chunks", () => {
    const report = new ChunkInspector().inspect(input([]));

    expect(report.inspectedChunkCount).toBe(0);
    expect(report.findings).toContainEqual(expect.objectContaining({
      candidateId: null,
      ruleCode: "NO_CHUNKS",
      blocksApproval: true,
    }));
  });

  test("flags table-like staff text that was not marked as a table", () => {
    const text = `Department\nName Age Designation\nEducational Qualification\nTotal No. of years of experience\nExperience & Background\nETF\nMr. Akshay Udeshi\n30 years\nETF Product & Fund Manager\nMBA Finance\n6 years`;
    const report = new ChunkInspector().inspect(input([candidate(0, text)]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "TABLE_LIKE_TEXT_NOT_MARKED_TABLE",
      severity: "critical",
    }));
  });

  test("detects the Akshay staff row split across adjacent chunks", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "ETF Mr. Akshay Udeshi 30 years ETF Product &", { pageNumbers: [28] }),
      candidate(1, "Fund Manager MBA Finance B.E Electronics 6 years Mr. Akshay Udeshi has over 6 years of experience.", {
        pageNumbers: [28, 29],
        sectionHeader: "Fund Manager",
      }),
    ]));

    const finding = report.findings.find(
      (item) => item.ruleCode === "CROSS_CHUNK_ROW_CONTINUATION",
    );
    expect(finding).toBeDefined();
    expect(finding?.candidateId).toBe("candidate-1");
    expect(finding?.blocksApproval).toBe(true);
    expect(finding?.evidence).toEqual(expect.objectContaining({
      previousChunkIndex: 0,
      currentChunkIndex: 1,
    }));
  });

  test("does not treat table placeholders or complete URLs as broken continuations", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "3. Equity derivatives 0% --"),
      candidate(1, "4. Securitized Debt 0%", { sectionHeader: "4. Securitized Debt 0%" }),
      candidate(2, "See https://www.miraeassetmf.co.in/"),
      candidate(3, "XVI. New Fund Offer Price", { sectionHeader: "XVI. New Fund Offer Price" }),
    ]));

    expect(report.findings.map((finding) => finding.ruleCode))
      .not.toContain("CROSS_CHUNK_ROW_CONTINUATION");
  });

  test("warns when a chunk contains only its heading", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "Got Questions? We've Got Answers!", {
        tokenCount: 8,
        sectionHeader: "Got Questions? We've Got Answers!",
      }),
    ]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "HEADING_ONLY_CHUNK",
      severity: "warning",
      blocksApproval: false,
    }));
  });

  test("adds one document warning when required addendum metadata is incomplete", () => {
    const addendumMetadata = {
      documentScope: "regulatory" as const,
      documentType: "Addendum",
      fundName: "Mirae Asset Gold ETF Fund",
      amendmentNumber: "AD/02/2026",
      effectiveDate: null,
      addendumChunkingMode: "semantic_fallback",
      addendumFallbackReason: "incomplete_metadata",
    };
    const report = new ChunkInspector().inspect(input([
      candidate(0, "First semantic addendum chunk.", { metadata: addendumMetadata }),
      candidate(1, "Second semantic addendum chunk.", { metadata: addendumMetadata }),
    ]));

    expect(report.findings.filter((item) => item.ruleCode === "ADDENDUM_METADATA_INCOMPLETE"))
      .toEqual([expect.objectContaining({
        candidateId: null,
        severity: "warning",
        blocksApproval: false,
        evidence: {
          missingFields: ["effectiveDate"],
          fallbackReason: "incomplete_metadata",
        },
      })]);
  });

  test("warns when complete addendum metadata still cannot produce safely paired provisions", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "Unpaired addendum provision.", {
        metadata: {
          documentScope: "regulatory",
          documentType: "Addendum",
          fundName: "Mirae Asset Gold ETF Fund",
          amendmentNumber: "AD/03/2026",
          effectiveDate: "2026-01-15",
          addendumChunkingMode: "semantic_fallback",
          addendumFallbackReason: "unpaired_provisions",
        },
      }),
    ]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      candidateId: null,
      ruleCode: "ADDENDUM_SPECIALIZED_CHUNKING_UNAVAILABLE",
      severity: "warning",
      blocksApproval: false,
      evidence: { missingFields: [], fallbackReason: "unpaired_provisions" },
    }));
  });

  test("does not warn when required addendum metadata is complete", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "Complete addendum provision.", {
        metadata: {
          documentScope: "regulatory",
          documentType: "Addendum",
          fundName: "Mirae Asset Gold ETF Fund",
          amendmentNumber: "AD/02/2026",
          effectiveDate: "2026-01-08",
          addendumChunkingMode: "specialized",
          addendumFallbackReason: null,
        },
      }),
    ]));

    expect(report.findings.map((item) => item.ruleCode)).not.toEqual(expect.arrayContaining([
      "ADDENDUM_METADATA_INCOMPLETE",
      "ADDENDUM_SPECIALIZED_CHUNKING_UNAVAILABLE",
    ]));
  });

  test("blocks missing and out-of-range page references", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "Content without a source page.", { pageNumbers: [] }),
      candidate(1, "Content from an impossible source page.", { pageNumbers: [21] }),
    ]));

    expect(report.findings.map((finding) => finding.ruleCode)).toContain("MISSING_PAGE_REFERENCE");
    expect(report.findings.map((finding) => finding.ruleCode)).toContain("PAGE_OUT_OF_RANGE");
  });

  test("supports zero-based synthetic sections for HTML", () => {
    const report = new ChunkInspector().inspect({
      document: {
        id: "html-1",
        filename: "article.md",
        pageCount: 2,
        pageNumberBase: 0,
      },
      candidates: [candidate(0, "Article preamble with sufficient explanatory content.", {
        pageNumbers: [0],
      })],
    });

    expect(report.findings.map((item) => item.ruleCode)).not.toContain("PAGE_OUT_OF_RANGE");
  });

  test("uses separate token limits for text and tables", () => {
    const inspector = new ChunkInspector({ maxTextTokens: 10, maxTableTokens: 20 });
    const report = inspector.inspect(input([
      candidate(0, "ordinary text", { tokenCount: 11 }),
      candidate(1, "| A | B |", { tokenCount: 15, hasTable: true }),
    ]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      candidateId: "candidate-0",
      ruleCode: "TOKEN_LIMIT_EXCEEDED",
    }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({
      candidateId: "candidate-1",
      ruleCode: "TOKEN_LIMIT_EXCEEDED",
    }));
  });

  test("accepts a table inside the default 1536-token allowance", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "[TABLE]\n| Rule | Details |", { tokenCount: 1400, hasTable: true }),
    ]));

    expect(report.findings).not.toContainEqual(expect.objectContaining({
      ruleCode: "TOKEN_LIMIT_EXCEEDED",
    }));
  });

  test("blocks FAQ candidates with missing structural, source, or ownership metadata", () => {
    const report = new ChunkInspector().inspect({
      document: { id: "faq-1", filename: "faq.pdf", pageCount: 10 },
      ownership: {
        visibilityScope: "TENANT",
        tenantId: "tenant-a",
      },
      candidates: [candidate(0, "Question: \nAnswer: ", {
        metadata: {
          documentScope: "regulatory",
          documentKind: "FAQ",
          sourceCollection: "general_mf_faq",
          documentTitle: "",
          publisher: "",
          sourceUrl: "",
          originalQuestion: "",
          answer: "",
        },
      })],
    });

    expect(report.findings.map((finding) => finding.ruleCode)).toEqual(
      expect.arrayContaining([
        "FAQ_QUESTION_MISSING",
        "FAQ_ANSWER_MISSING",
        "FAQ_SOURCE_MISSING",
        "FAQ_GLOBAL_OWNERSHIP_REQUIRED",
      ]),
    );
    expect(report.findings.filter((finding) =>
      finding.ruleCode.startsWith("FAQ_")).every((finding) => finding.blocksApproval)
    ).toBe(true);
  });

  test("blocks merged questions, source loss, index leakage, and exact duplicate FAQ text", () => {
    const metadata = {
      documentScope: "regulatory" as const,
      documentKind: "FAQ" as const,
      sourceCollection: "general_mf_faq",
      documentTitle: "Investor FAQ",
      publisher: "Authority",
      sourceUrl: "https://example.test/faq.pdf",
      originalQuestion: "What is NAV?",
      answer: "NAV is the per-unit value.",
      normalizedQuestionKey: "what is nav",
      sourceCoverageComplete: false,
    };
    const duplicateText = "Question: What is NAV? Answer: NAV is the per-unit value.";
    const report = new ChunkInspector().inspect({
      document: { id: "faq-1", filename: "faq.pdf", pageCount: 10 },
      ownership: { visibilityScope: "GLOBAL", tenantId: null },
      candidates: [
        candidate(0, `Contents\n${duplicateText}\n2. What is expense ratio?`, { metadata }),
        candidate(1, duplicateText, { metadata }),
        candidate(2, duplicateText, { metadata }),
      ],
    });

    expect(report.findings.map((finding) => finding.ruleCode)).toEqual(
      expect.arrayContaining([
        "FAQ_MERGED_QUESTIONS",
        "FAQ_SOURCE_TEXT_LOSS",
        "FAQ_INDEX_LEAKAGE",
        "FAQ_EXACT_DUPLICATE",
      ]),
    );
  });

  test("warns for time-sensitive FAQ guidance and materially different cross-source answers", () => {
    const base = {
      documentScope: "regulatory" as const,
      documentKind: "FAQ" as const,
      sourceCollection: "general_mf_faq",
      originalQuestion: "What is the tax on mutual funds?",
      normalizedQuestionKey: "what is the tax on mutual funds",
      sourceUrl: "https://example.test/faq.pdf",
      sourceDate: "2024-09-25",
    };
    const report = new ChunkInspector().inspect({
      document: { id: "faq-1", filename: "faq.pdf", pageCount: 10 },
      ownership: { visibilityScope: "GLOBAL", tenantId: null },
      candidates: [
        candidate(0, "Question: What is the tax? Answer: The current tax rate is 10%.", {
          metadata: {
            ...base,
            documentTitle: "SEBI FAQ",
            publisher: "SEBI",
            answer: "The current tax rate is 10%.",
          },
        }),
        candidate(1, "Question: What is the tax? Answer: The applicable tax rate is 12.5%.", {
          metadata: {
            ...base,
            documentTitle: "NISM FAQ",
            publisher: "NISM",
            sourceUrl: "https://example.test/nism.pdf",
            sourceDate: "2021-02-01",
            answer: "The applicable tax rate is 12.5%.",
          },
        }),
      ],
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "FAQ_TIME_SENSITIVE",
      severity: "warning",
      blocksApproval: false,
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "FAQ_CROSS_SOURCE_CONFLICT",
      severity: "warning",
      blocksApproval: false,
    }));
  });

  describe("Docling rules", () => {
    const parserDiagnostics = { lowStructurePages: [], uncoveredPages: [] };
    function docling(
      chunkIndex: number,
      text: string,
      chunkType: string,
      extra: Record<string, unknown> = {},
    ): InspectionCandidate {
      return candidate(chunkIndex, text, {
        hasTable: chunkType === "table",
        metadata: {
          documentScope: "strategy",
          documentType: "Factsheet",
          parser: "docling",
          chunkType,
          normalizationFlags: [],
          sourceItemRefs: [`#/texts/${chunkIndex}`],
          parserDiagnostics,
          ...extra,
        },
      });
    }
    const ruleCodes = (report: { findings: { ruleCode: string }[] }) =>
      report.findings.map((item) => item.ruleCode);

    test("reports inspector version 1.1.0", () => {
      expect(new ChunkInspector().inspect(input([])).inspectorVersion).toBe("1.1.0");
    });

    test("blocks table and key-value chunks that repeat a span", () => {
      const report = new ChunkInspector().inspect(input([
        docling(0, "Mirae Asset Flexi Cap Fund\nFund Details\nNet AUM: Net AUM: ₹4,506.259 Cr.", "key_value"),
        docling(1, "Fund Details, 1 = Fund Details", "table"),
        docling(2, "Scheme | Regular Plan | Regular Plan | 10.2%", "table"),
      ]));

      const duplications = report.findings.filter((item) => item.ruleCode === "TABLE_SPAN_DUPLICATION");
      expect(duplications.map((item) => item.chunkIndex)).toEqual([0, 1, 2]);
      expect(duplications[0]).toMatchObject({
        severity: "critical",
        blocksApproval: true,
        evidence: { pattern: "repeated_label", line: "Net AUM: Net AUM: ₹4,506.259 Cr." },
      });
      expect(duplications[1]!.evidence).toMatchObject({ pattern: "triplet_label_value" });
      expect(duplications[2]!.evidence).toMatchObject({ pattern: "adjacent_cell" });
    });

    test("does not flag normalized tables, numeric repeats, or text chunks", () => {
      const report = new ChunkInspector().inspect(input([
        docling(0, "Returns for last 1 year, Scheme Returns Regular (%) = 6.62%. Returns for last 1 year, Benchmark (%) = 5.1%", "table"),
        docling(1, "--, Previous Month Rating = --. --, Current Month Rating = --", "table"),
        docling(2, "Total Amount Invested | 120,000 | 120,000", "table"),
        docling(3, "Net AUM: Net AUM: repeated in prose", "text"),
        docling(4, "Date of Inception/ Allotment: 24th February 2023\nNet AUM: ₹4,506.259 Cr.", "key_value"),
      ]));

      expect(ruleCodes(report)).not.toContain("TABLE_SPAN_DUPLICATION");
    });

    test("warns on picture chunks whose chart values could not be bound", () => {
      const report = new ChunkInspector().inspect(input([
        docling(0, "Regular Direct Benchmark\nFY 23 10.1 11.2", "picture", {
          normalizationFlags: ["picture_text_recovered", "chart_multi_series_unparsed"],
          pictureClassification: "bar_chart",
        }),
        docling(1, "Equity Holdings Cash & Other Receivables\n99.42%\n0.58%", "picture", {
          normalizationFlags: ["picture_text_recovered", "chart_unpaired"],
          pictureClassification: "pie_chart",
        }),
        docling(2, "Banks: 16.61%", "picture", {
          normalizationFlags: ["picture_text_recovered", "chart_pairs_extracted"],
          pictureClassification: "bar_chart",
        }),
      ]));

      const unbound = report.findings.filter((item) => item.ruleCode === "CHART_VALUES_UNBOUND");
      expect(unbound.map((item) => item.chunkIndex)).toEqual([0, 1]);
      expect(unbound[0]).toMatchObject({
        severity: "warning",
        blocksApproval: false,
        evidence: {
          classification: "bar_chart",
          flags: ["picture_text_recovered", "chart_multi_series_unparsed"],
        },
      });
    });

    test("warns once per document about low-structure and uncovered pages", () => {
      const diagnostics = { lowStructurePages: [3], uncoveredPages: [7] };
      const report = new ChunkInspector().inspect(input([
        docling(0, "Fund Details text", "text", { parserDiagnostics: diagnostics }),
        docling(1, "More text", "text", { parserDiagnostics: diagnostics }),
      ]));

      const lowStructure = report.findings.filter((item) => item.ruleCode === "LOW_STRUCTURE_PAGE");
      expect(lowStructure).toEqual([expect.objectContaining({
        candidateId: null,
        chunkIndex: null,
        severity: "warning",
        blocksApproval: false,
        evidence: diagnostics,
      })]);
      expect(ruleCodes(new ChunkInspector().inspect(input([docling(0, "Fund text", "text")]))))
        .not.toContain("LOW_STRUCTURE_PAGE");
    });

    test("leaves findings for non-Docling candidates unchanged", () => {
      const unpdf = [
        candidate(0, "Net AUM: Net AUM: ₹4,506.259 Cr.", { hasTable: true }),
        candidate(1, "Fund Details, 1 = Fund Details", { hasTable: true }),
        candidate(2, "Regular Direct Benchmark", {
          metadata: {
            documentScope: "strategy",
            documentType: "Factsheet",
            chunkType: "picture",
            normalizationFlags: ["chart_unpaired"],
            parserDiagnostics: { lowStructurePages: [1], uncoveredPages: [2] },
          },
        }),
      ];

      expect(new ChunkInspector().inspect(input(unpdf)).findings).toEqual(
        new ChunkInspector({ inspectorVersion: "1.0.0" }).inspect(input(unpdf)).findings,
      );
      expect(new ChunkInspector().inspect(input(unpdf)).findings).toEqual([]);
    });
  });
});

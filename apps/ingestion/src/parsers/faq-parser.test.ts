import { describe, expect, test } from "bun:test";

import { parseFaqPages } from "./faq-parser.ts";

describe("FAQ structural parser", () => {
  test("keeps an unnumbered SEBI answer across pages without joining the next question", () => {
    const result = parseFaqPages({
      profile: "sebi-unnumbered-v1",
      expectedQuestionCount: { min: 2, max: 3 },
      pages: [
        {
          pageNumber: 1,
          text: [
            "Introduction",
            "What is a mutual fund?",
            "A mutual fund pools investors' money and invests it",
          ].join("\n"),
        },
        {
          pageNumber: 2,
          text: [
            "across securities according to its stated objective.",
            "How is NAV calculated?",
            "NAV is the value of assets less liabilities per unit.",
          ].join("\n"),
        },
      ],
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(expect.objectContaining({
      question: "What is a mutual fund?",
      pageNumbers: [1, 2],
    }));
    expect(result.items[0]!.answer).toContain("across securities");
    expect(result.items[0]!.answer).not.toContain("How is NAV");
    expect(result.items[1]!.question).toBe("How is NAV calculated?");
    expect(result.coverage.unexplained).toEqual([]);
  });

  test("parses numbered NISM Ans. pairs, topics, and excludes non-content", () => {
    const result = parseFaqPages({
      profile: "nism-numbered-v1",
      expectedQuestionCount: { min: 2, max: 3 },
      pages: [
        {
          pageNumber: 1,
          text: [
            "MUTUAL FUND FAQS",
            "Contents",
            "I. Mutual Fund Investing ........ 3",
            "Page 1 of 3",
          ].join("\n"),
        },
        {
          pageNumber: 2,
          text: [
            "I. Mutual Fund Investing",
            "1. What is a Mutual Fund?",
            "Ans. A mutual fund is a pool of money",
          ].join("\n"),
        },
        {
          pageNumber: 3,
          text: [
            "managed by a professional fund manager.",
            "2. Why diversify?",
            "Ans. Diversification spreads risk.",
            "Page 3 of 3",
          ].join("\n"),
        },
      ],
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(expect.objectContaining({
      questionNumber: "1",
      topic: "Mutual Fund Investing",
      pageNumbers: [2, 3],
    }));
    expect(result.items[0]!.answer).toContain("professional fund manager");
    expect(result.items[0]!.answer).not.toContain("Why diversify");
    expect(result.coverage.excluded.map((segment) => segment.reason)).toContain("contents");
    expect(result.coverage.excluded.map((segment) => segment.reason)).toContain("page_footer");
    expect(result.coverage.unexplained).toEqual([]);
  });

  test("blocks review readiness for missing answers and extraction drift", () => {
    const result = parseFaqPages({
      profile: "nism-numbered-v1",
      expectedQuestionCount: { min: 2, max: 2 },
      pages: [{
        pageNumber: 1,
        text: "I. Investing\n1. What is NAV?\nThis line has no answer marker.",
      }],
    });

    expect(result.reviewReady).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/answer/i),
      expect.stringMatching(/question count/i),
    ]));
    expect(result.coverage.unexplained.length).toBeGreaterThan(0);
  });

  test("accepts NISM answer markers split from their body", () => {
    const result = parseFaqPages({
      profile: "nism-numbered-v1",
      expectedQuestionCount: { min: 1, max: 1 },
      pages: [{
        pageNumber: 7,
        text: "II. Products\n26. What is an open-ended fund?\nAns.\nIt accepts ongoing subscriptions.",
      }],
    });

    expect(result.reviewReady).toBe(true);
    expect(result.items[0]!.answer).toBe("It accepts ongoing subscriptions.");
  });

  test("does not turn numbered answer clauses into questions", () => {
    const result = parseFaqPages({
      profile: "nism-numbered-v1",
      expectedQuestionCount: { min: 1, max: 1 },
      pages: [{
        pageNumber: 60,
        text: [
          "383. What are the usages of real estate assets?",
          "Ans. Assets may be managed under these conditions:",
          "2. Where assets are leased, rent must be collected diligently.",
        ].join("\n"),
      }],
    });

    expect(result.reviewReady).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.answer).toContain("2. Where assets are leased");
  });

  test("recovers NISM questions and Ans. markers concatenated to prior answers", () => {
    const result = parseFaqPages({
      profile: "nism-numbered-v1",
      expectedQuestionCount: { min: 2, max: 2 },
      expectedQuestionNumbers: { first: 134, last: 135 },
      pages: [{
        pageNumber: 18,
        text: [
          "134. What happened first?",
          "Ans. The first event concluded. 135. In which year did the next event occur? Ans. It occurred later.",
        ].join("\n"),
      }],
    });

    expect(result.reviewReady).toBe(true);
    expect(result.items.map((item) => item.questionNumber)).toEqual(["134", "135"]);
    expect(result.items[0]!.answer).toBe("The first event concluded.");
    expect(result.items[1]!.answer).toBe("It occurred later.");
  });

  test("excludes numbered NISM cover credits before question sequencing", () => {
    const result = parseFaqPages({
      profile: "nism-numbered-v1",
      expectedQuestionCount: { min: 1, max: 1 },
      expectedQuestionNumbers: { first: 1, last: 1 },
      pages: [
        {
          pageNumber: 1,
          text: "FAQs on Mutual Funds\nFaculty Guide:\nA. Teacher\nCollators:\n1. First Person\n2. Second Person\nIndex",
        },
        {
          pageNumber: 3,
          text: "I. Investing\n1. What is a mutual fund?\nAns. It is a pooled investment.",
        },
      ],
    });

    expect(result.reviewReady).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.question).toBe("What is a mutual fund?");
    expect(result.coverage.excluded.every((segment) => segment.pageNumber === 1
      || segment.reason === "topic_heading")).toBe(true);
  });

  test("blocks an incomplete configured question-number sequence", () => {
    const result = parseFaqPages({
      profile: "nism-numbered-v1",
      expectedQuestionCount: { min: 2, max: 3 },
      expectedQuestionNumbers: { first: 1, last: 3 },
      pages: [{
        pageNumber: 1,
        text: "1. First question?\nAns. First answer.\n3. Third question?\nAns. Third answer.",
      }],
    });

    expect(result.reviewReady).toBe(false);
    expect(result.blockers).toContain(
      "FAQ question-number sequence is incomplete; missing: 2.",
    );
  });

  test("never silently falls back for an unsupported source profile", () => {
    expect(() => parseFaqPages({
      profile: "generic-pdf" as never,
      expectedQuestionCount: { min: 1, max: 2 },
      pages: [{ pageNumber: 1, text: "Question?\nAnswer." }],
    })).toThrow(/unsupported.*profile/i);
  });
});

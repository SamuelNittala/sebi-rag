import { describe, expect, mock, test } from "bun:test";

import { TeiReranker } from "./reranker.ts";

describe("TeiReranker", () => {
  test("sends query and chunks to TEI and returns validated scores", async () => {
    const fetcher = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(String(_input)).toBe("http://reranker:80/rerank");
      expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({
        query: "When can I withdraw through SWP?",
        texts: ["SIP dates 1 to 28", "SWP dates 1, 10, 21"],
        raw_scores: false,
        return_text: false,
        truncate: true,
        truncation_direction: "Right",
      });
      return Response.json([
        { index: 1, score: 0.99 },
        { index: 0, score: 0.22 },
      ]);
    });
    const reranker = new TeiReranker({
      baseUrl: "http://reranker:80",
      fetcher,
    });

    await expect(reranker.rerank(
      "When can I withdraw through SWP?",
      ["SIP dates 1 to 28", "SWP dates 1, 10, 21"],
      2,
    )).resolves.toEqual([
      { index: 1, score: 0.99 },
      { index: 0, score: 0.22 },
    ]);
  });

  test("rejects invalid result indices instead of corrupting the ranking", async () => {
    const reranker = new TeiReranker({
      fetcher: mock(async () => Response.json([
        { index: 4, score: 0.9 },
      ])),
    });

    await expect(reranker.rerank("query", ["only document"], 1)).rejects.toThrow(
      "invalid result index",
    );
  });

  test("reports TEI health without throwing when the service is down", async () => {
    const healthy = new TeiReranker({
      fetcher: mock(async () => new Response("ok")),
    });
    const unavailable = new TeiReranker({
      fetcher: mock(async () => {
        throw new Error("connection refused");
      }),
    });

    await expect(healthy.checkHealth()).resolves.toBe(true);
    await expect(unavailable.checkHealth()).resolves.toBe(false);
  });
});

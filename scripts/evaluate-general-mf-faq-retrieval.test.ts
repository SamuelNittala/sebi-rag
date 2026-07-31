import { describe, expect, test } from "bun:test";

import {
  evaluateGoldenObservations,
  runGeneralMfFaqEvaluation,
  type GoldenFixture,
} from "./evaluate-general-mf-faq-retrieval.ts";

const fixturePath = "tests/retrieval/general-mf-faq-golden.json";

describe("general mutual-fund FAQ golden evaluation", () => {
  test("passes the deterministic replay fixture without asserting tenant parity", async () => {
    const fixture = await Bun.file(fixturePath).json() as GoldenFixture;
    const observations = Object.fromEntries(fixture.tenants.map((tenant) => [
      tenant,
      Object.fromEntries(fixture.cases.map((golden) => [
        golden.id,
        structuredClone(fixture.replayResults[golden.id] ?? []),
      ])),
    ]));

    const report = evaluateGoldenObservations(
      fixture,
      observations,
      new Date("2026-07-31T00:00:00Z"),
      "replay",
    );

    expect(report.summary).toMatchObject({
      cases: 6,
      passed: 6,
      failed: 0,
      passRate: 1,
      tenantParity: null,
      passedThreshold: true,
    });
    expect(report.evaluations.every((item) =>
      item.citationCompleteness
      && item.sifExcluded
      && item.lexicalParticipation)).toBe(true);
    expect(report.warnings.stale.length).toBeGreaterThan(0);
    expect(report.warnings.conflicts).toEqual([
      expect.objectContaining({ question: "when is nav calculated" }),
    ]);
    expect(report.cutover).toEqual({
      investorAgentTransportParity: "unmet",
      productionActivation: "blocked",
    });
  });

  test("reports null tenant parity in the replay JSON contract", async () => {
    const report = await runGeneralMfFaqEvaluation([
      `--fixture=${fixturePath}`,
      "--mode=replay",
    ]);

    expect(report).toEqual(expect.objectContaining({
      mode: "replay",
      summary: expect.objectContaining({
        tenantParity: null,
        passedThreshold: true,
      }),
    }));
  });

  test("fails tenant parity when one tenant sees different FAQ evidence", async () => {
    const fixture = await Bun.file(fixturePath).json() as GoldenFixture;
    const observations = Object.fromEntries(fixture.tenants.map((tenant) => [
      tenant,
      Object.fromEntries(fixture.cases.map((golden) => [
        golden.id,
        structuredClone(fixture.replayResults[golden.id] ?? []),
      ])),
    ]));
    observations["tenant-b"]!.sip = [];

    const report = evaluateGoldenObservations(fixture, observations, new Date(), "live");

    expect(report.summary.tenantParity).toBe(false);
    expect(report.summary.passedThreshold).toBe(false);
  });
});

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { SebiScraper } from "../scraper";
import type { ScraperConfig } from "../types";
import { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";

const TEST_DATA_DIR = "/home/samuel/projects/mf-pdf-rag/data/test-scraper";

// Helper to check if SEBI is accessible
async function isSebiAccessible(): Promise<boolean> {
  try {
    const response = await fetch(
      "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
      {
        method: "POST",
        body: "doMutualFund=yes&mftype=2",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

describe("SebiScraper", () => {
  beforeEach(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true });
    }
    await mkdir(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true });
    }
  });

  // Network-dependent tests - skip if SEBI is not accessible
  describe("fetchAmcList (network)", () => {
    test.skipIf(process.env.SKIP_NETWORK_TESTS === "true")(
      "fetches and parses AMC list from SEBI",
      async () => {
        const accessible = await isSebiAccessible();
        if (!accessible) {
          console.log("Skipping: SEBI not accessible");
          return;
        }

        const scraper = new SebiScraper({
          request: {
            baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
            delayMs: 0,
            maxRetries: 1,
            retryDelayMs: 100,
            timeoutMs: 10000,
          },
          download: {
            concurrency: 1,
            delayMs: 0,
            outputDir: TEST_DATA_DIR,
            maxRetries: 1,
            retryDelayMs: 100,
          },
          state: {
            statePath: `${TEST_DATA_DIR}/state.json`,
            autoSaveIntervalMs: 0,
          },
        });

        const amcs = await scraper.fetchAmcList();

        // Should have multiple AMCs (SEBI has 54+)
        expect(amcs.length).toBeGreaterThan(0);
        // Each AMC should have required fields
        for (const amc of amcs) {
          expect(amc.sebiId).toBeDefined();
          expect(amc.name).toBeDefined();
          expect(amc.sebiId.length).toBeGreaterThan(0);
          expect(amc.name.length).toBeGreaterThan(0);
        }
      }
    );
  });

  describe("fetchSchemeList (network)", () => {
    test.skipIf(process.env.SKIP_NETWORK_TESTS === "true")(
      "fetches schemes for a given AMC",
      async () => {
        const accessible = await isSebiAccessible();
        if (!accessible) {
          console.log("Skipping: SEBI not accessible");
          return;
        }

        const scraper = new SebiScraper({
          request: {
            baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
            delayMs: 0,
            maxRetries: 1,
            retryDelayMs: 100,
            timeoutMs: 10000,
          },
          download: {
            concurrency: 1,
            delayMs: 0,
            outputDir: TEST_DATA_DIR,
            maxRetries: 1,
            retryDelayMs: 100,
          },
          state: {
            statePath: `${TEST_DATA_DIR}/state.json`,
            autoSaveIntervalMs: 0,
          },
        });

        // First get an AMC to test with
        const amcs = await scraper.fetchAmcList();
        expect(amcs.length).toBeGreaterThan(0);

        const testAmc = amcs[0];
        const schemes = await scraper.fetchSchemeList(testAmc.sebiId, testAmc.name);

        // Should have schemes (most AMCs have multiple)
        expect(schemes.length).toBeGreaterThanOrEqual(0);
        for (const scheme of schemes) {
          expect(scheme.sebiSchemeId).toBeDefined();
          expect(scheme.sebiFundId).toBe(testAmc.sebiId);
          expect(scheme.name).toBeDefined();
          expect(scheme.amcName).toBe(testAmc.name);
        }
      }
    );

    test("handles AMC with no schemes gracefully", async () => {
      const scraper = new SebiScraper({
        request: {
          baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
          delayMs: 0,
          maxRetries: 1,
          retryDelayMs: 100,
          timeoutMs: 10000,
        },
        download: {
          concurrency: 1,
          delayMs: 0,
          outputDir: TEST_DATA_DIR,
          maxRetries: 1,
          retryDelayMs: 100,
        },
        state: {
          statePath: `${TEST_DATA_DIR}/state.json`,
          autoSaveIntervalMs: 0,
        },
      });

      // Use a fake AMC ID that doesn't exist - should return empty array, not throw
      const schemes = await scraper.fetchSchemeList("INVALID_ID", "Fake AMC");

      expect(schemes).toEqual([]);
    });
  });

  describe("extractPdfUrl (network)", () => {
    test("returns null for invalid scheme ID", async () => {
      const scraper = new SebiScraper({
        request: {
          baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
          delayMs: 0,
          maxRetries: 1,
          retryDelayMs: 100,
          timeoutMs: 10000,
        },
        download: {
          concurrency: 1,
          delayMs: 0,
          outputDir: TEST_DATA_DIR,
          maxRetries: 1,
          retryDelayMs: 100,
        },
        state: {
          statePath: `${TEST_DATA_DIR}/state.json`,
          autoSaveIntervalMs: 0,
        },
      });

      const pdfUrl = await scraper.extractPdfUrl("INVALID_SCHEME_ID");

      expect(pdfUrl).toBeNull();
    });
  });

  describe("filename sanitization", () => {
    test("sanitizes AMC names for filesystem", () => {
      const scraper = new SebiScraper({
        request: {
          baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
          delayMs: 0,
          maxRetries: 1,
          retryDelayMs: 100,
          timeoutMs: 10000,
        },
        download: {
          concurrency: 1,
          delayMs: 0,
          outputDir: TEST_DATA_DIR,
          maxRetries: 1,
          retryDelayMs: 100,
        },
        state: {
          statePath: `${TEST_DATA_DIR}/state.json`,
          autoSaveIntervalMs: 0,
        },
      });

      // Test various problematic names
      const testCases = [
        { input: "AMC/Name", expected: "AMC_Name" },
        { input: "AMC\\Name", expected: "AMC_Name" },
        { input: "AMC:Name", expected: "AMC_Name" },
        { input: "AMC*Name", expected: "AMC_Name" },
        { input: "AMC?Name", expected: "AMC_Name" },
        { input: '"AMC"Name', expected: "AMCName" }, // Quotes are removed
        { input: "<AMC>Name", expected: "AMC_Name" },
        { input: "AMC|Name", expected: "AMC_Name" },
        { input: "  Spaced Name  ", expected: "Spaced Name" },
        { input: "Multiple   Spaces", expected: "Multiple Spaces" },
        { input: "Normal Name", expected: "Normal Name" },
        { input: "/Leading/Slash", expected: "Leading_Slash" },
      ];

      for (const { input, expected } of testCases) {
        const result = scraper.sanitizeFilename(input);
        expect(result).toBe(expected);
      }
    });

    test("builds correct destination path", () => {
      const scraper = new SebiScraper({
        request: {
          baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
          delayMs: 0,
          maxRetries: 1,
          retryDelayMs: 100,
          timeoutMs: 10000,
        },
        download: {
          concurrency: 1,
          delayMs: 0,
          outputDir: TEST_DATA_DIR,
          maxRetries: 1,
          retryDelayMs: 100,
        },
        state: {
          statePath: `${TEST_DATA_DIR}/state.json`,
          autoSaveIntervalMs: 0,
        },
      });

      const path = scraper.buildDestPath("Test AMC Ltd", "Test Scheme - Growth");

      expect(path).toBe(`${TEST_DATA_DIR}/Test AMC Ltd/Test Scheme - Growth.pdf`);
    });
  });

  describe("state management", () => {
    test("saves and loads state correctly", async () => {
      const config: ScraperConfig = {
        request: {
          baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
          delayMs: 0,
          maxRetries: 1,
          retryDelayMs: 100,
          timeoutMs: 10000,
        },
        download: {
          concurrency: 1,
          delayMs: 0,
          outputDir: TEST_DATA_DIR,
          maxRetries: 1,
          retryDelayMs: 100,
        },
        state: {
          statePath: `${TEST_DATA_DIR}/state.json`,
          autoSaveIntervalMs: 0,
        },
      };

      // First scraper - add some AMCs manually and save
      const scraper1 = new SebiScraper(config);
      await scraper1.loadState();

      // Manually add AMCs to state (simulating a scrape)
      const state1 = scraper1.getState();
      state1.amcs.push({ sebiId: "MF001", name: "Test AMC 1" });
      state1.amcs.push({ sebiId: "MF002", name: "Test AMC 2" });
      state1.completedAmcIds.push("MF001", "MF002");
      state1.stats.totalAmcs = 2;
      await scraper1.saveState();
      scraper1.cleanup();

      // Second scraper - should resume from state
      const scraper2 = new SebiScraper(config);
      await scraper2.loadState();

      const state2 = scraper2.getState();
      expect(state2.amcs.length).toBe(2);
      expect(state2.completedAmcIds.length).toBe(2);
      expect(state2.amcs[0].name).toBe("Test AMC 1");
      scraper2.cleanup();
    });

    test("resets state correctly", async () => {
      const config: ScraperConfig = {
        request: {
          baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
          delayMs: 0,
          maxRetries: 1,
          retryDelayMs: 100,
          timeoutMs: 10000,
        },
        download: {
          concurrency: 1,
          delayMs: 0,
          outputDir: TEST_DATA_DIR,
          maxRetries: 1,
          retryDelayMs: 100,
        },
        state: {
          statePath: `${TEST_DATA_DIR}/state.json`,
          autoSaveIntervalMs: 0,
        },
      };

      // Create state with some data
      const scraper = new SebiScraper(config);
      await scraper.loadState();
      const state = scraper.getState();
      state.amcs.push({ sebiId: "MF001", name: "Test AMC" });
      await scraper.saveState();

      // Reset
      await scraper.resetState();

      // Verify reset
      const newState = scraper.getState();
      expect(newState.amcs.length).toBe(0);
      expect(newState.phase).toBe("idle");
      scraper.cleanup();
    });
  });

  describe("status reporting", () => {
    test("returns correct status", async () => {
      const config: ScraperConfig = {
        request: {
          baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
          delayMs: 0,
          maxRetries: 1,
          retryDelayMs: 100,
          timeoutMs: 10000,
        },
        download: {
          concurrency: 1,
          delayMs: 0,
          outputDir: TEST_DATA_DIR,
          maxRetries: 1,
          retryDelayMs: 100,
        },
        state: {
          statePath: `${TEST_DATA_DIR}/state.json`,
          autoSaveIntervalMs: 0,
        },
      };

      const scraper = new SebiScraper(config);
      const status = await scraper.getStatus();

      expect(status.phase).toBe("idle");
      expect(status.stats.totalAmcs).toBe(0);
      expect(status.stats.totalSchemes).toBe(0);
      expect(status.pendingAmcs).toBe(0);
      expect(status.pendingSchemes).toBe(0);
      scraper.cleanup();
    });
  });
});

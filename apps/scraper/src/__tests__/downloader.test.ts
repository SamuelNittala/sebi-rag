import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { downloadPdf, downloadWithRetry, createDownloadPool } from "../downloader";
import type { DownloadTask, DownloadResult } from "../types";
import { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";

const TEST_DIR = "/home/samuel/projects/mf-pdf-rag/data/test-downloads";

describe("PDF Downloader", () => {
  beforeEach(async () => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Clean up after tests
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true });
    }
  });

  describe("downloadPdf", () => {
    test("successfully downloads a PDF file", async () => {
      const task: DownloadTask = {
        url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        destPath: `${TEST_DIR}/test.pdf`,
        schemeId: "SCH001",
        schemeName: "Test Scheme",
        amcName: "Test AMC",
      };

      const result = await downloadPdf(task);

      expect(result.success).toBe(true);
      expect(result.schemeId).toBe("SCH001");
      expect(result.path).toBe(`${TEST_DIR}/test.pdf`);
      expect(result.size).toBeGreaterThan(0);
      expect(existsSync(`${TEST_DIR}/test.pdf`)).toBe(true);
    });

    test("creates parent directories if they don't exist", async () => {
      const task: DownloadTask = {
        url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
        destPath: `${TEST_DIR}/nested/dirs/test.pdf`,
        schemeId: "SCH001",
        schemeName: "Test Scheme",
        amcName: "Test AMC",
      };

      const result = await downloadPdf(task);

      expect(result.success).toBe(true);
      expect(existsSync(`${TEST_DIR}/nested/dirs/test.pdf`)).toBe(true);
    });

    test("returns failure for invalid URL", async () => {
      const task: DownloadTask = {
        url: "https://invalid-domain-that-does-not-exist-12345.com/file.pdf",
        destPath: `${TEST_DIR}/fail.pdf`,
        schemeId: "SCH002",
        schemeName: "Fail Scheme",
        amcName: "Fail AMC",
      };

      const result = await downloadPdf(task);

      expect(result.success).toBe(false);
      expect(result.schemeId).toBe("SCH002");
      expect(result.error).toBeDefined();
      expect(existsSync(`${TEST_DIR}/fail.pdf`)).toBe(false);
    });

    test("returns failure for 404 response", async () => {
      const task: DownloadTask = {
        url: "https://www.sebi.gov.in/nonexistent-file-that-does-not-exist.pdf",
        destPath: `${TEST_DIR}/not-found.pdf`,
        schemeId: "SCH003",
        schemeName: "Not Found Scheme",
        amcName: "Not Found AMC",
      };

      const result = await downloadPdf(task);

      expect(result.success).toBe(false);
      expect(result.error).toContain("404");
    });
  });

  describe("downloadWithRetry", () => {
    test("retries on failure and eventually succeeds", async () => {
      let attempts = 0;
      const mockDownload = async (task: DownloadTask): Promise<DownloadResult> => {
        attempts++;
        if (attempts < 3) {
          return {
            success: false,
            schemeId: task.schemeId,
            error: `Attempt ${attempts} failed`,
          };
        }
        return {
          success: true,
          schemeId: task.schemeId,
          path: task.destPath,
          size: 1000,
        };
      };

      const task: DownloadTask = {
        url: "https://example.com/test.pdf",
        destPath: `${TEST_DIR}/retry-test.pdf`,
        schemeId: "SCH004",
        schemeName: "Retry Scheme",
        amcName: "Retry AMC",
      };

      const result = await downloadWithRetry(task, mockDownload, {
        maxRetries: 3,
        retryDelayMs: 10, // Short delay for tests
      });

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
    });

    test("gives up after max retries", async () => {
      let attempts = 0;
      const mockDownload = async (task: DownloadTask): Promise<DownloadResult> => {
        attempts++;
        return {
          success: false,
          schemeId: task.schemeId,
          error: `Attempt ${attempts} failed`,
        };
      };

      const task: DownloadTask = {
        url: "https://example.com/test.pdf",
        destPath: `${TEST_DIR}/max-retry.pdf`,
        schemeId: "SCH005",
        schemeName: "Max Retry Scheme",
        amcName: "Max Retry AMC",
      };

      const result = await downloadWithRetry(task, mockDownload, {
        maxRetries: 3,
        retryDelayMs: 10,
      });

      expect(result.success).toBe(false);
      expect(attempts).toBe(3);
      expect(result.error).toContain("failed");
    });

    test("applies exponential backoff", async () => {
      const delays: number[] = [];
      let lastTime = Date.now();
      let attempts = 0;

      const mockDownload = async (task: DownloadTask): Promise<DownloadResult> => {
        const now = Date.now();
        if (attempts > 0) {
          delays.push(now - lastTime);
        }
        lastTime = now;
        attempts++;
        return {
          success: false,
          schemeId: task.schemeId,
          error: "Always fails",
        };
      };

      const task: DownloadTask = {
        url: "https://example.com/test.pdf",
        destPath: `${TEST_DIR}/backoff.pdf`,
        schemeId: "SCH006",
        schemeName: "Backoff Scheme",
        amcName: "Backoff AMC",
      };

      await downloadWithRetry(task, mockDownload, {
        maxRetries: 3,
        retryDelayMs: 50,
      });

      // Second delay should be roughly 2x first (exponential backoff)
      // Allow some tolerance for timing
      expect(delays.length).toBe(2);
      expect(delays[1]).toBeGreaterThan(delays[0] * 1.5);
    });
  });

  describe("createDownloadPool", () => {
    test("limits concurrent downloads to specified concurrency", async () => {
      let currentConcurrency = 0;
      let maxConcurrency = 0;
      const mockDownload = async (task: DownloadTask): Promise<DownloadResult> => {
        currentConcurrency++;
        maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
        await new Promise((resolve) => setTimeout(resolve, 50));
        currentConcurrency--;
        return {
          success: true,
          schemeId: task.schemeId,
          path: task.destPath,
          size: 100,
        };
      };

      const tasks: DownloadTask[] = Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/file${i}.pdf`,
        destPath: `${TEST_DIR}/pool-${i}.pdf`,
        schemeId: `SCH${i}`,
        schemeName: `Scheme ${i}`,
        amcName: "Test AMC",
      }));

      const pool = createDownloadPool(mockDownload, { concurrency: 3, delayMs: 0 });
      await pool.downloadAll(tasks);

      expect(maxConcurrency).toBeLessThanOrEqual(3);
    });

    test("applies delay between starting downloads", async () => {
      const startTimes: number[] = [];
      const mockDownload = async (task: DownloadTask): Promise<DownloadResult> => {
        startTimes.push(Date.now());
        return {
          success: true,
          schemeId: task.schemeId,
          path: task.destPath,
          size: 100,
        };
      };

      const tasks: DownloadTask[] = Array.from({ length: 5 }, (_, i) => ({
        url: `https://example.com/file${i}.pdf`,
        destPath: `${TEST_DIR}/delay-${i}.pdf`,
        schemeId: `SCH${i}`,
        schemeName: `Scheme ${i}`,
        amcName: "Test AMC",
      }));

      const pool = createDownloadPool(mockDownload, { concurrency: 10, delayMs: 50 });
      await pool.downloadAll(tasks);

      // Check that consecutive starts have at least some delay
      for (let i = 1; i < startTimes.length; i++) {
        const gap = startTimes[i] - startTimes[i - 1];
        expect(gap).toBeGreaterThanOrEqual(40); // Allow some tolerance
      }
    });

    test("returns results for all tasks", async () => {
      const mockDownload = async (task: DownloadTask): Promise<DownloadResult> => {
        return {
          success: task.schemeId !== "SCH2", // Make one fail
          schemeId: task.schemeId,
          path: task.destPath,
          size: 100,
          error: task.schemeId === "SCH2" ? "Intentional failure" : undefined,
        };
      };

      const tasks: DownloadTask[] = Array.from({ length: 5 }, (_, i) => ({
        url: `https://example.com/file${i}.pdf`,
        destPath: `${TEST_DIR}/result-${i}.pdf`,
        schemeId: `SCH${i}`,
        schemeName: `Scheme ${i}`,
        amcName: "Test AMC",
      }));

      const pool = createDownloadPool(mockDownload, { concurrency: 3, delayMs: 0 });
      const results = await pool.downloadAll(tasks);

      expect(results).toHaveLength(5);
      expect(results.filter((r) => r.success)).toHaveLength(4);
      expect(results.filter((r) => !r.success)).toHaveLength(1);
    });

    test("emits progress events", async () => {
      const progressEvents: { completed: number; total: number }[] = [];
      const mockDownload = async (task: DownloadTask): Promise<DownloadResult> => {
        return {
          success: true,
          schemeId: task.schemeId,
          path: task.destPath,
          size: 100,
        };
      };

      const tasks: DownloadTask[] = Array.from({ length: 5 }, (_, i) => ({
        url: `https://example.com/file${i}.pdf`,
        destPath: `${TEST_DIR}/progress-${i}.pdf`,
        schemeId: `SCH${i}`,
        schemeName: `Scheme ${i}`,
        amcName: "Test AMC",
      }));

      const pool = createDownloadPool(mockDownload, { concurrency: 1, delayMs: 0 });
      pool.onProgress((completed, total) => {
        progressEvents.push({ completed, total });
      });
      await pool.downloadAll(tasks);

      expect(progressEvents).toHaveLength(5);
      expect(progressEvents[0]).toEqual({ completed: 1, total: 5 });
      expect(progressEvents[4]).toEqual({ completed: 5, total: 5 });
    });
  });
});

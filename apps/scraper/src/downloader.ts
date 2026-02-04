/**
 * PDF Downloader for SEBI Mutual Fund Documents
 *
 * Handles downloading PDFs with retry logic, concurrency control, and progress tracking.
 */

import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import type { DownloadTask, DownloadResult } from "./types";

/**
 * Downloads a single PDF file
 */
export async function downloadPdf(task: DownloadTask): Promise<DownloadResult> {
  try {
    // Create parent directories if needed
    const dir = dirname(task.destPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Extract actual PDF URL if wrapped
    let pdfUrl = task.url;
    if (task.url.includes("/web/?file=")) {
      const urlObj = new URL(task.url);
      const fileParam = urlObj.searchParams.get("file");
      if (fileParam) {
        pdfUrl = fileParam;
      }
    }

    // Make the request
    const response = await fetch(pdfUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/pdf,*/*",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        schemeId: task.schemeId,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    // Get the content
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      return {
        success: false,
        schemeId: task.schemeId,
        error: "Empty response body",
      };
    }

    // Write to file
    await Bun.write(task.destPath, buffer);

    return {
      success: true,
      schemeId: task.schemeId,
      path: task.destPath,
      size: buffer.byteLength,
    };
  } catch (error) {
    return {
      success: false,
      schemeId: task.schemeId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries: number;
  retryDelayMs: number;
}

/**
 * Downloads with retry logic and exponential backoff
 */
export async function downloadWithRetry(
  task: DownloadTask,
  downloadFn: (task: DownloadTask) => Promise<DownloadResult>,
  options: RetryOptions
): Promise<DownloadResult> {
  let lastResult: DownloadResult | null = null;
  let delay = options.retryDelayMs;

  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    lastResult = await downloadFn(task);

    if (lastResult.success) {
      return lastResult;
    }

    // Don't delay after the last attempt
    if (attempt < options.maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }

  return lastResult!;
}

/**
 * Pool options
 */
export interface PoolOptions {
  concurrency: number;
  delayMs: number;
}

/**
 * Creates a download pool with concurrency control
 */
export function createDownloadPool(
  downloadFn: (task: DownloadTask) => Promise<DownloadResult>,
  options: PoolOptions
): DownloadPool {
  return new DownloadPool(downloadFn, options);
}

/**
 * Download pool for managing concurrent downloads
 */
export class DownloadPool {
  private downloadFn: (task: DownloadTask) => Promise<DownloadResult>;
  private concurrency: number;
  private delayMs: number;
  private progressCallback?: (completed: number, total: number) => void;
  private lastStartTime = 0;
  private startLock = Promise.resolve();

  constructor(
    downloadFn: (task: DownloadTask) => Promise<DownloadResult>,
    options: PoolOptions
  ) {
    this.downloadFn = downloadFn;
    this.concurrency = options.concurrency;
    this.delayMs = options.delayMs;
  }

  /**
   * Register progress callback
   */
  onProgress(callback: (completed: number, total: number) => void): void {
    this.progressCallback = callback;
  }

  /**
   * Acquire a start slot with delay enforcement
   */
  private async acquireStartSlot(): Promise<void> {
    // Serialize access to ensure delays are sequential
    const prevLock = this.startLock;
    let releaseLock: () => void;
    this.startLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await prevLock;

    // Ensure minimum delay since last start
    const now = Date.now();
    const elapsed = now - this.lastStartTime;
    if (this.delayMs > 0 && elapsed < this.delayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.delayMs - elapsed)
      );
    }
    this.lastStartTime = Date.now();

    releaseLock!();
  }

  /**
   * Download all tasks with concurrency limit
   */
  async downloadAll(tasks: DownloadTask[]): Promise<DownloadResult[]> {
    const results: DownloadResult[] = [];
    let completed = 0;
    const total = tasks.length;

    // Reset timing state
    this.lastStartTime = 0;
    this.startLock = Promise.resolve();

    // Create a queue of pending tasks
    const queue = [...tasks];
    const inProgress = new Set<Promise<void>>();

    const processNext = async (): Promise<void> => {
      if (queue.length === 0) return;

      const task = queue.shift()!;

      // Acquire start slot (enforces delay between starts)
      await this.acquireStartSlot();

      const result = await this.downloadFn(task);
      results.push(result);
      completed++;

      if (this.progressCallback) {
        this.progressCallback(completed, total);
      }
    };

    // Process tasks with concurrency limit
    while (queue.length > 0 || inProgress.size > 0) {
      // Start new tasks up to concurrency limit
      while (queue.length > 0 && inProgress.size < this.concurrency) {
        const promise = processNext();
        inProgress.add(promise);
        promise.finally(() => inProgress.delete(promise));
      }

      // Wait for at least one to complete
      if (inProgress.size > 0) {
        await Promise.race(inProgress);
      }
    }

    return results;
  }
}

/**
 * Creates a download function with built-in retry
 */
export function createDownloadWithRetry(
  retryOptions: RetryOptions
): (task: DownloadTask) => Promise<DownloadResult> {
  return (task: DownloadTask) =>
    downloadWithRetry(task, downloadPdf, retryOptions);
}

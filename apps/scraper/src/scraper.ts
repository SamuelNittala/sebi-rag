/**
 * SEBI Mutual Fund Scraper
 *
 * Main scraper class that orchestrates fetching AMCs, schemes, and downloading PDFs.
 */

import type {
  AMC,
  Scheme,
  ScraperConfig,
  ScrapeState,
  DownloadTask,
  DownloadResult,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { parseAmcList, parseSchemeList, parsePdfUrl } from "./parser";
import { StateManager } from "./state";
import {
  createDownloadPool,
  createDownloadWithRetry,
  downloadPdf,
  downloadWithRetry,
} from "./downloader";
import { join } from "path";

/**
 * Options for scraping operations
 */
export interface ScrapeOptions {
  /** Limit number of AMCs to process (for testing) */
  limit?: number;
  /** Verbose logging */
  verbose?: boolean;
}

/**
 * Result of metadata scraping
 */
export interface ScrapeMetadataResult {
  amcs: AMC[];
  totalSchemes: number;
  errors: string[];
}

/**
 * Result of PDF downloads
 */
export interface DownloadPdfsResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: string[];
}

/**
 * SEBI Mutual Fund Scraper
 */
export class SebiScraper {
  private config: ScraperConfig;
  private stateManager: StateManager;
  private lastRequestTime = 0;

  constructor(config: Partial<ScraperConfig> = {}) {
    // Merge with defaults
    this.config = {
      request: { ...DEFAULT_CONFIG.request, ...config.request },
      download: { ...DEFAULT_CONFIG.download, ...config.download },
      state: { ...DEFAULT_CONFIG.state, ...config.state },
    };

    this.stateManager = new StateManager(this.config.state.statePath, {
      autoSaveIntervalMs: this.config.state.autoSaveIntervalMs,
    });
  }

  /**
   * Rate-limited fetch
   */
  private async rateLimitedFetch(
    url: string,
    options?: RequestInit
  ): Promise<Response> {
    // Ensure minimum delay between requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.config.request.delayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.request.delayMs - timeSinceLastRequest)
      );
    }
    this.lastRequestTime = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.request.timeoutMs
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml,*/*",
          "Content-Type": "application/x-www-form-urlencoded",
          ...options?.headers,
        },
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Make a POST request to SEBI
   */
  private async fetchFromSebi(params: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.request.maxRetries; attempt++) {
      try {
        const url = `${this.config.request.baseUrl}?${params}`;
        const response = await this.rateLimitedFetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.request.maxRetries) {
          const delay =
            this.config.request.retryDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Fetch list of all AMCs from SEBI
   */
  async fetchAmcList(): Promise<AMC[]> {
    const html = await this.fetchFromSebi("doMutualFund=yes&mftype=2");
    const result = parseAmcList(html);
    return result.amcs;
  }

  /**
   * Fetch schemes for a given AMC
   */
  async fetchSchemeList(amcId: string, amcName: string): Promise<Scheme[]> {
    try {
      const html = await this.fetchFromSebi(`doGetFundDetails=yes&type=2&mfId=${amcId}`);
      const result = parseSchemeList(html, amcId, amcName);
      return result.schemes;
    } catch {
      return [];
    }
  }

  /**
   * Extract PDF URL from scheme detail page
   */
  async extractPdfUrl(schemeId: string): Promise<string | null> {
    try {
      const html = await this.fetchFromSebi(`doGetFundDetails=yes&mfdId=${schemeId}`);
      const result = parsePdfUrl(html);
      return result.url;
    } catch {
      return null;
    }
  }

  /**
   * Sanitize a string for use as a filename
   */
  sanitizeFilename(name: string): string {
    return name
      .trim() // Trim first
      .replace(/["']/g, "") // Remove quotes entirely (they surround text)
      .replace(/[/\\:*?<>|]/g, "_") // Replace other illegal characters with underscore
      .replace(/_+/g, "_") // Collapse multiple underscores
      .replace(/^_|_$/g, "") // Remove leading/trailing underscores
      .replace(/\s+/g, " "); // Normalize whitespace
  }

  /**
   * Build destination path for a PDF
   */
  buildDestPath(amcName: string, schemeName: string): string {
    const safeAmcName = this.sanitizeFilename(amcName);
    const safeSchemeName = this.sanitizeFilename(schemeName);
    return join(
      this.config.download.outputDir,
      safeAmcName,
      `${safeSchemeName}.pdf`
    );
  }

  /**
   * Load state from disk
   */
  async loadState(): Promise<void> {
    await this.stateManager.initialize();
  }

  /**
   * Save state to disk
   */
  async saveState(): Promise<void> {
    await this.stateManager.save();
  }

  /**
   * Get current state
   */
  getState(): ScrapeState {
    return this.stateManager.getState();
  }

  /**
   * Reset state
   */
  async resetState(): Promise<void> {
    await this.stateManager.reset();
  }

  /**
   * Scrape all metadata (AMCs and schemes)
   */
  async scrapeMetadata(options: ScrapeOptions = {}): Promise<ScrapeMetadataResult> {
    await this.loadState();
    const errors: string[] = [];

    // Phase 1: Fetch AMC list
    this.stateManager.setPhase("scraping_amcs");

    if (this.stateManager.getState().amcs.length === 0) {
      if (options.verbose) {
        console.log("Fetching AMC list...");
      }

      try {
        const amcs = await this.fetchAmcList();
        this.stateManager.addAmcs(amcs);
        await this.saveState();

        if (options.verbose) {
          console.log(`Found ${amcs.length} AMCs`);
        }
      } catch (error) {
        errors.push(
          `Failed to fetch AMC list: ${error instanceof Error ? error.message : String(error)}`
        );
        return {
          amcs: [],
          totalSchemes: 0,
          errors,
        };
      }
    }

    // Phase 2: Fetch schemes for each AMC
    this.stateManager.setPhase("scraping_schemes");

    let amcsToProcess = this.stateManager.getPendingAmcs();

    // Apply limit if specified
    if (options.limit && options.limit > 0) {
      amcsToProcess = amcsToProcess.slice(0, options.limit);
    }

    for (const amc of amcsToProcess) {
      if (options.verbose) {
        console.log(`Fetching schemes for ${amc.name}...`);
      }

      try {
        const schemes = await this.fetchSchemeList(amc.sebiId, amc.name);
        this.stateManager.addSchemes(schemes);
        this.stateManager.markAmcComplete(amc.sebiId);
        await this.saveState();

        if (options.verbose) {
          console.log(`  Found ${schemes.length} schemes`);
        }
      } catch (error) {
        errors.push(
          `Failed to fetch schemes for ${amc.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const state = this.stateManager.getState();
    return {
      amcs: state.amcs,
      totalSchemes: state.schemes.length,
      errors,
    };
  }

  /**
   * Download PDFs for all scraped schemes
   */
  async downloadPdfs(options: ScrapeOptions = {}): Promise<DownloadPdfsResult> {
    await this.loadState();
    const errors: string[] = [];

    this.stateManager.setPhase("downloading");

    // Get schemes to download
    let schemes = this.stateManager.getPendingSchemes();

    // Apply limit if specified
    if (options.limit && options.limit > 0) {
      schemes = schemes.slice(0, options.limit);
    }

    // First, extract PDF URLs for schemes that don't have them
    const schemesNeedingUrls = schemes.filter((s) => !s.pdfUrl);
    for (const scheme of schemesNeedingUrls) {
      if (options.verbose) {
        console.log(`Extracting PDF URL for ${scheme.name}...`);
      }

      const pdfUrl = await this.extractPdfUrl(scheme.sebiSchemeId);
      this.stateManager.updateSchemePdfUrl(scheme.sebiSchemeId, pdfUrl);

      if (!pdfUrl) {
        if (options.verbose) {
          console.log(`  No PDF URL found`);
        }
      }
    }

    await this.saveState();

    // Now download schemes with PDF URLs
    const downloadableSchemes = this.stateManager.getDownloadableSchemes();
    let downloadTasks: DownloadTask[] = downloadableSchemes.map((scheme) => ({
      url: scheme.pdfUrl!,
      destPath: this.buildDestPath(scheme.amcName, scheme.name),
      schemeId: scheme.sebiSchemeId,
      schemeName: scheme.name,
      amcName: scheme.amcName,
    }));

    // Apply limit if specified (and not already applied above)
    if (options.limit && options.limit > 0) {
      downloadTasks = downloadTasks.slice(0, options.limit);
    }

    const downloadFn = createDownloadWithRetry({
      maxRetries: this.config.download.maxRetries,
      retryDelayMs: this.config.download.retryDelayMs,
    });

    const pool = createDownloadPool(downloadFn, {
      concurrency: this.config.download.concurrency,
      delayMs: this.config.download.delayMs,
    });

    if (options.verbose) {
      pool.onProgress((completed, total) => {
        console.log(`Progress: ${completed}/${total} (${Math.round((completed / total) * 100)}%)`);
      });
    }

    const results = await pool.downloadAll(downloadTasks);

    // Update state based on results
    let succeeded = 0;
    let failed = 0;

    for (const result of results) {
      if (result.success) {
        this.stateManager.markSchemeComplete(result.schemeId);
        succeeded++;
      } else {
        this.stateManager.markSchemeFailed(result.schemeId);
        failed++;
        errors.push(`${result.schemeId}: ${result.error}`);
      }
    }

    await this.saveState();

    const skipped = schemes.length - downloadTasks.length;

    return {
      attempted: downloadTasks.length,
      succeeded,
      failed,
      skipped,
      errors,
    };
  }

  /**
   * Get current status/progress
   */
  async getStatus(): Promise<{
    phase: ScrapeState["phase"];
    stats: ScrapeState["stats"];
    lastUpdated: string;
    pendingAmcs: number;
    pendingSchemes: number;
  }> {
    await this.loadState();
    const state = this.stateManager.getState();

    return {
      phase: state.phase,
      stats: state.stats,
      lastUpdated: state.lastUpdated,
      pendingAmcs: this.stateManager.getPendingAmcs().length,
      pendingSchemes: this.stateManager.getPendingSchemes().length,
    };
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.stateManager.stopAutoSave();
  }
}

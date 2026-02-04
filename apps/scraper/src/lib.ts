/**
 * SEBI Mutual Fund Scraper Library
 *
 * Re-exports all public APIs for use as a library.
 */

// Types
export type {
  AMC,
  Scheme,
  DownloadTask,
  DownloadResult,
  ScrapePhase,
  ScrapeStats,
  ScrapeState,
  RequestConfig,
  DownloadConfig,
  StateConfig,
  ScraperConfig,
  CliCommand,
  CliOptions,
  CliResult,
  AmcListParseResult,
  SchemeListParseResult,
  PdfUrlParseResult,
} from "./types";

export { DEFAULT_CONFIG, createInitialState } from "./types";

// Parser
export { parseAmcList, parseSchemeList, parsePdfUrl, parsePdfLinks } from "./parser";

// State Management
export { loadState, saveState, resetState, StateManager } from "./state";

// Downloader
export {
  downloadPdf,
  downloadWithRetry,
  createDownloadPool,
  createDownloadWithRetry,
  DownloadPool,
} from "./downloader";
export type { RetryOptions, PoolOptions } from "./downloader";

// Scraper
export { SebiScraper } from "./scraper";
export type {
  ScrapeOptions,
  ScrapeMetadataResult,
  DownloadPdfsResult,
} from "./scraper";

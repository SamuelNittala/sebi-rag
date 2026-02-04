/**
 * SEBI Mutual Fund Scraper Types
 *
 * These types define the data structures for scraping SEBI's mutual fund database.
 */

// ============================================================================
// Core Data Types
// ============================================================================

/**
 * Asset Management Company from SEBI database
 */
export interface AMC {
  /** SEBI's unique identifier for the AMC */
  sebiId: string;
  /** Official name of the AMC */
  name: string;
}

/**
 * Mutual fund scheme from SEBI database
 */
export interface Scheme {
  /** SEBI's unique identifier for the scheme */
  sebiSchemeId: string;
  /** SEBI ID of the parent AMC */
  sebiFundId: string;
  /** Scheme name as registered with SEBI */
  name: string;
  /** Name of the parent AMC */
  amcName: string;
  /** Direct URL to the PDF document (if available) */
  pdfUrl?: string;
  /** Local filesystem path after download */
  pdfPath?: string;
}

/**
 * Download task for a single PDF
 */
export interface DownloadTask {
  /** URL to download from */
  url: string;
  /** Destination file path */
  destPath: string;
  /** Scheme ID for tracking */
  schemeId: string;
  /** Scheme name for logging */
  schemeName: string;
  /** AMC name for logging */
  amcName: string;
}

/**
 * Result of a download attempt
 */
export interface DownloadResult {
  /** Whether the download succeeded */
  success: boolean;
  /** Scheme ID */
  schemeId: string;
  /** File path if successful */
  path?: string;
  /** File size in bytes if successful */
  size?: number;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// State Management Types
// ============================================================================

/**
 * Phases of the scraping process
 */
export type ScrapePhase =
  | "idle"
  | "scraping_amcs"
  | "scraping_schemes"
  | "downloading"
  | "completed";

/**
 * Scrape progress statistics
 */
export interface ScrapeStats {
  /** Total number of AMCs found */
  totalAmcs: number;
  /** Total number of schemes found */
  totalSchemes: number;
  /** Number of PDFs successfully downloaded */
  downloadedPdfs: number;
  /** Number of failed downloads */
  failedDownloads: number;
  /** Number of schemes without PDF URLs */
  noPdfUrl: number;
}

/**
 * Persistent state for resumable scraping
 */
export interface ScrapeState {
  /** Current phase of operation */
  phase: ScrapePhase;
  /** List of all discovered AMCs */
  amcs: AMC[];
  /** List of all discovered schemes */
  schemes: Scheme[];
  /** SEBI IDs of AMCs that have been fully scraped for schemes */
  completedAmcIds: string[];
  /** SEBI IDs of schemes whose PDFs have been downloaded */
  completedSchemeIds: string[];
  /** SEBI IDs of schemes that failed to download */
  failedSchemeIds: string[];
  /** Timestamp of last state update */
  lastUpdated: string; // ISO date string for JSON serialization
  /** Progress statistics */
  stats: ScrapeStats;
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for HTTP requests
 */
export interface RequestConfig {
  /** Base URL for SEBI website */
  baseUrl: string;
  /** Delay between requests in milliseconds */
  delayMs: number;
  /** Maximum retry attempts for failed requests */
  maxRetries: number;
  /** Initial retry delay in milliseconds (doubles each retry) */
  retryDelayMs: number;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

/**
 * Configuration for downloads
 */
export interface DownloadConfig {
  /** Maximum concurrent downloads */
  concurrency: number;
  /** Delay between starting new downloads (ms) */
  delayMs: number;
  /** Base directory for storing PDFs */
  outputDir: string;
  /** Maximum retry attempts */
  maxRetries: number;
  /** Initial retry delay (ms) */
  retryDelayMs: number;
}

/**
 * Configuration for state persistence
 */
export interface StateConfig {
  /** Path to state file */
  statePath: string;
  /** Auto-save interval in milliseconds (0 = manual only) */
  autoSaveIntervalMs: number;
}

/**
 * Full scraper configuration
 */
export interface ScraperConfig {
  request: RequestConfig;
  download: DownloadConfig;
  state: StateConfig;
}

// ============================================================================
// Function Signatures
// ============================================================================

/**
 * Fetches the list of all AMCs from SEBI
 * @returns Array of AMCs
 */
export type FetchAmcList = () => Promise<AMC[]>;

/**
 * Fetches all schemes for a given AMC
 * @param amcId - SEBI ID of the AMC
 * @returns Array of schemes
 */
export type FetchSchemeList = (amcId: string) => Promise<Scheme[]>;

/**
 * Extracts the PDF URL from a scheme's detail page
 * @param schemeId - SEBI scheme ID
 * @returns PDF URL or null if not available
 */
export type ExtractPdfUrl = (schemeId: string) => Promise<string | null>;

/**
 * Downloads a PDF file with retry logic
 * @param task - Download task details
 * @returns Download result
 */
export type DownloadPdf = (task: DownloadTask) => Promise<DownloadResult>;

/**
 * Loads scrape state from disk
 * @returns Loaded state or initial state if none exists
 */
export type LoadState = () => Promise<ScrapeState>;

/**
 * Saves scrape state to disk
 * @param state - Current state to persist
 */
export type SaveState = (state: ScrapeState) => Promise<void>;

/**
 * Resets scrape state (deletes state file)
 */
export type ResetState = () => Promise<void>;

// ============================================================================
// Parser Types
// ============================================================================

/**
 * Result of parsing AMC list HTML
 */
export interface AmcListParseResult {
  amcs: AMC[];
  errors: string[];
}

/**
 * Result of parsing scheme list HTML
 */
export interface SchemeListParseResult {
  schemes: Scheme[];
  errors: string[];
}

/**
 * Result of parsing scheme detail HTML for PDF URL
 */
export interface PdfUrlParseResult {
  url: string | null;
  error?: string;
}

// ============================================================================
// CLI Types
// ============================================================================

/**
 * Available CLI commands
 */
export type CliCommand = "scrape" | "download" | "status" | "reset" | "help";

/**
 * CLI command options
 */
export interface CliOptions {
  /** Only scrape first N AMCs (for testing) */
  limit?: number;
  /** Verbose output */
  verbose?: boolean;
  /** Force overwrite existing files */
  force?: boolean;
  /** Dry run (don't actually download) */
  dryRun?: boolean;
}

/**
 * CLI command result
 */
export interface CliResult {
  success: boolean;
  message: string;
  stats?: ScrapeStats;
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default scraper configuration
 */
export const DEFAULT_CONFIG: ScraperConfig = {
  request: {
    baseUrl: "https://www.sebi.gov.in/sebiweb/other/OtherAction.do",
    delayMs: 500,
    maxRetries: 3,
    retryDelayMs: 1000,
    timeoutMs: 30000,
  },
  download: {
    concurrency: 3,
    delayMs: 500,
    outputDir: "data/sebi-pdfs",
    maxRetries: 3,
    retryDelayMs: 1000,
  },
  state: {
    statePath: "data/scrape-state.json",
    autoSaveIntervalMs: 0,
  },
};

/**
 * Creates an empty initial state
 */
export function createInitialState(): ScrapeState {
  return {
    phase: "idle",
    amcs: [],
    schemes: [],
    completedAmcIds: [],
    completedSchemeIds: [],
    failedSchemeIds: [],
    lastUpdated: new Date().toISOString(),
    stats: {
      totalAmcs: 0,
      totalSchemes: 0,
      downloadedPdfs: 0,
      failedDownloads: 0,
      noPdfUrl: 0,
    },
  };
}

# SEBI Mutual Fund Scraper Specification

## Problem Statement

SEBI (Securities and Exchange Board of India) maintains a public database of all registered mutual fund schemes with their Scheme Information Documents (SIDs). These PDFs contain authoritative fund metadata and detailed scheme information that is valuable for building a comprehensive mutual fund knowledge base.

Currently, there is no automated way to:
1. Enumerate all AMCs (Asset Management Companies) and their schemes from SEBI's database
2. Download the associated PDF documents in an organized structure
3. Store authoritative SEBI identifiers for linking to the ingestion pipeline

This scraper solves these problems by systematically scraping the SEBI mutual fund database and downloading all available PDFs.

---

## Functional Requirements

### FR-1: AMC List Retrieval
- **Description**: Fetch the complete list of AMCs registered with SEBI
- **Input**: SEBI mutual fund database URL with `doMutualFund=yes&mftype=2`
- **Output**: Array of AMC objects containing `sebiId`, `name`
- **Acceptance**: Returns 54+ AMCs (verified count as of 2026)

### FR-2: Scheme List Retrieval
- **Description**: Fetch all schemes for a given AMC
- **Input**: AMC SEBI ID
- **Output**: Array of Scheme objects containing `sebiSchemeId`, `name`, `amcId`, `amcName`
- **Acceptance**: Returns schemes with valid IDs for each AMC

### FR-3: PDF URL Extraction
- **Description**: Extract the direct PDF download URL from a scheme's detail page
- **Input**: Scheme SEBI ID
- **Output**: Direct PDF URL (format: `sebi_data/mutualfundfile/{month-year}/{file}.pdf`)
- **Acceptance**: Returns valid downloadable PDF URL or null if unavailable

### FR-4: PDF Download
- **Description**: Download PDF files to organized directory structure
- **Input**: PDF URL, AMC name, Scheme name
- **Output**: File saved to `data/sebi-pdfs/{AMC_Name}/{Scheme_Name}.pdf`
- **Acceptance**: File exists with non-zero size after download

### FR-5: State Persistence
- **Description**: Persist scraping state for resume capability
- **Input**: Current scrape state (AMCs, schemes, downloads)
- **Output**: JSON file at `data/scrape-state.json`
- **Acceptance**: State can be loaded and scraping resumes from last position

### FR-6: Database Storage
- **Description**: Store AMC and scheme metadata in PostgreSQL for lookup
- **Input**: Scraped AMC and scheme data
- **Output**: Records in `amcs` and updated `funds` tables with SEBI IDs
- **Acceptance**: All scraped entities have corresponding database records

### FR-7: CLI Interface
- **Description**: Command-line interface for controlling scraper operations
- **Commands**:
  - `scrape` - Scrape AMC and scheme metadata only (no downloads)
  - `download` - Download PDFs for scraped schemes
  - `status` - Show current scrape/download progress
  - `reset` - Clear state and start fresh
- **Acceptance**: All commands execute without error and provide appropriate output

---

## Non-Functional Requirements

### NFR-1: Concurrency
- Maximum 3 concurrent downloads at any time
- Prevents overwhelming SEBI servers and reduces chance of blocking

### NFR-2: Rate Limiting
- 500ms minimum delay between HTTP requests
- Polite scraping behavior even though no anti-scraping measures detected

### NFR-3: Resume Capability
- Scraping can be interrupted and resumed without data loss
- State persisted after each AMC/scheme/download completes
- On restart, skip already-completed items

### NFR-4: Retry Logic
- HTTP requests retry up to 3 times with exponential backoff
- Initial delay: 1 second, multiplied by 2 each retry
- Transient network errors should not fail entire scrape

### NFR-5: Error Handling
- Individual scheme failures do not stop entire scrape
- Errors logged with context (AMC name, scheme name, URL)
- Failed items marked in state for potential retry

### NFR-6: Progress Reporting
- Console output shows current AMC/scheme being processed
- Progress percentage for download phase
- Summary statistics on completion

### NFR-7: File Organization
- PDFs organized by AMC: `data/sebi-pdfs/{AMC_Name}/{Scheme_Name}.pdf`
- Filenames sanitized (no special characters that break filesystems)
- Duplicate names handled with numeric suffix

---

## Technical Decisions

### TD-1: HTML Parsing with Cheerio
**Decision**: Use Cheerio for HTML parsing instead of browser automation (Puppeteer/Playwright)

**Rationale**:
- SEBI website uses server-rendered HTML with simple AJAX requests
- No JavaScript-heavy SPA or dynamic content requiring full browser
- Cheerio is lightweight (~2MB vs ~300MB for Puppeteer)
- Faster execution (no browser startup overhead)
- Lower resource consumption

### TD-2: State Storage as JSON File
**Decision**: Store scrape state in a JSON file rather than database

**Rationale**:
- State is transient (only needed during scraping)
- Simple to inspect and debug
- No migration needed
- Easy to reset by deleting file
- Database is for authoritative data, not operational state

### TD-3: Bun Native HTTP
**Decision**: Use Bun's native fetch API instead of axios/node-fetch

**Rationale**:
- Zero dependencies (Bun has fetch built-in)
- Better performance (Bun's HTTP is highly optimized)
- Consistent with project's Bun-first approach
- Full support for streaming responses for large PDFs

### TD-4: Semaphore Pattern for Concurrency
**Decision**: Use a semaphore/pool pattern for managing concurrent downloads

**Rationale**:
- Clean separation between concurrency control and download logic
- Easy to adjust concurrency limit
- Prevents callback hell from manual promise management
- Well-tested pattern for I/O-bound operations

### TD-5: Separate AMC Table
**Decision**: Create a new `amcs` table rather than embedding AMC data in funds

**Rationale**:
- One AMC has many funds (proper normalization)
- AMC metadata (SEBI ID, name) is authoritative and shouldn't be duplicated
- Enables future features (AMC-level filtering, AMC pages)
- Matches SEBI's data model

---

## Data Model

### AMC (Asset Management Company)
```typescript
interface AMC {
  id: string;           // UUID (internal)
  sebiId: string;       // SEBI's ID (e.g., "MF001")
  name: string;         // Official AMC name
  createdAt: Date;
}
```

### Scheme (extends Fund)
```typescript
interface Scheme {
  sebiSchemeId: string; // SEBI's scheme ID
  sebiFundId: string;   // Reference to AMC's SEBI ID
  name: string;
  amcName: string;
  pdfUrl?: string;      // Direct PDF URL if available
  pdfPath?: string;     // Local path after download
}
```

### ScrapeState
```typescript
interface ScrapeState {
  phase: 'idle' | 'scraping_amcs' | 'scraping_schemes' | 'downloading';
  amcs: AMC[];
  schemes: Scheme[];
  completedAmcIds: string[];      // SEBI IDs of fully scraped AMCs
  completedSchemeIds: string[];   // SEBI IDs of downloaded schemes
  failedSchemeIds: string[];      // SEBI IDs that failed
  lastUpdated: Date;
  stats: {
    totalAmcs: number;
    totalSchemes: number;
    downloadedPdfs: number;
    failedDownloads: number;
  };
}
```

---

## URL Patterns (Verified)

**Base URL**: `https://www.sebi.gov.in/sebiweb/other/OtherAction.do`

### 1. AMC List
```
POST https://www.sebi.gov.in/sebiweb/other/OtherAction.do
Body: doMutualFund=yes&mftype=2
```
Returns HTML table with 54 AMCs.

### 2. Schemes for AMC
```
POST https://www.sebi.gov.in/sebiweb/other/OtherAction.do
Body: doGetFundDetails=yes&type=2&mfId={sebiId}
```
Returns HTML table with schemes for that AMC.

### 3. Scheme Detail (PDF iframe)
```
POST https://www.sebi.gov.in/sebiweb/other/OtherAction.do
Body: doGetFundDetails=yes&mfdId={schemeId}
```
Returns HTML with iframe pointing to PDF.

### 4. Direct PDF Download
```
GET https://www.sebi.gov.in/sebi_data/mutualfundfile/{month-year}/{filename}.pdf
```
Direct PDF file download.

---

## Acceptance Criteria

### AC-1: Full Scrape Completion
- [ ] Scraper successfully retrieves all 54+ AMCs
- [ ] Each AMC's schemes are retrieved
- [ ] PDFs are downloaded for schemes that have them
- [ ] Final statistics match expected counts

### AC-2: Resume Works Correctly
- [ ] Interrupt scraper mid-operation (Ctrl+C)
- [ ] Restart scraper
- [ ] Scraper resumes from last completed item
- [ ] No duplicate downloads

### AC-3: Error Resilience
- [ ] Network error during download does not crash scraper
- [ ] Retry logic kicks in for transient failures
- [ ] Failed items are logged and recorded

### AC-4: Database Integration
- [ ] All AMCs stored in `amcs` table
- [ ] Funds table updated with `sebi_scheme_id` and `sebi_fund_id`
- [ ] Lookup by SEBI ID returns correct records

### AC-5: CLI Operations
- [ ] `bun run apps/scraper/src/index.ts scrape` completes metadata scrape
- [ ] `bun run apps/scraper/src/index.ts download` downloads PDFs
- [ ] `bun run apps/scraper/src/index.ts status` shows current state
- [ ] `bun run apps/scraper/src/index.ts reset` clears state

---

## Estimated Performance

Based on verified URL patterns and no anti-scraping measures:

- **AMC scraping**: ~30 seconds (54 AMCs, 500ms delay each)
- **Scheme scraping**: ~5 minutes (estimated 1000-1500 schemes)
- **PDF downloads**: ~15 minutes (3 concurrent, varying file sizes)
- **Total time**: ~20-25 minutes for complete scrape

---

## Usage Examples

### Full Scrape (Metadata + Downloads)
```bash
# Scrape all metadata
bun run apps/scraper/src/index.ts scrape

# Download PDFs (can run separately)
bun run apps/scraper/src/index.ts download
```

### Check Progress
```bash
bun run apps/scraper/src/index.ts status
# Output:
# Phase: downloading
# AMCs: 54/54 complete
# Schemes: 1,234/1,500 downloaded
# Failed: 12
# Estimated time remaining: 3 minutes
```

### Resume After Interrupt
```bash
# First run (interrupted)
bun run apps/scraper/src/index.ts download
# ^C (interrupted at 50%)

# Resume
bun run apps/scraper/src/index.ts download
# Continues from 50%, doesn't re-download completed files
```

### Reset and Start Fresh
```bash
bun run apps/scraper/src/index.ts reset
# Clears state file
# Does NOT delete already-downloaded PDFs

bun run apps/scraper/src/index.ts scrape
# Starts fresh scrape
```

### Programmatic Usage
```typescript
import { SebiScraper } from "./apps/scraper/src/lib";

const scraper = new SebiScraper({
  download: {
    concurrency: 3,
    delayMs: 500,
    outputDir: "data/sebi-pdfs",
    maxRetries: 3,
    retryDelayMs: 1000,
  },
});

// Scrape metadata only
const result = await scraper.scrapeMetadata({ verbose: true });
console.log(`Found ${result.amcs.length} AMCs, ${result.totalSchemes} schemes`);

// Download PDFs
const downloads = await scraper.downloadPdfs({ verbose: true });
console.log(`Downloaded: ${downloads.succeeded}, Failed: ${downloads.failed}`);

// Check status
const status = await scraper.getStatus();
console.log(`Phase: ${status.phase}, Pending: ${status.pendingSchemes}`);

// Clean up
scraper.cleanup();
```

---

## Implementation Notes

### File Structure
```
apps/scraper/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── scraper.ts         # Main SebiScraper class
│   ├── parser.ts          # HTML parsing with Cheerio
│   ├── downloader.ts      # Download pool with concurrency
│   ├── state.ts           # State persistence (JSON file)
│   ├── types.ts           # TypeScript interfaces
│   └── lib.ts             # Library exports
│   └── __tests__/         # Test files
├── spec.md                # This specification
└── package.json           # Package dependencies
```

### Dependencies
- `cheerio` - HTML parsing
- `bun` - Runtime and file I/O

### State File Format
State is persisted to `data/scrape-state.json`:
```json
{
  "phase": "downloading",
  "amcs": [{"sebiId": "MF001", "name": "..."}],
  "schemes": [{"sebiSchemeId": "...", "sebiFundId": "...", "name": "...", "pdfUrl": "..."}],
  "completedAmcIds": ["MF001", "MF002"],
  "completedSchemeIds": ["SCH001"],
  "failedSchemeIds": ["SCH999"],
  "lastUpdated": "2026-02-01T12:00:00Z",
  "stats": {
    "totalAmcs": 54,
    "totalSchemes": 1500,
    "downloadedPdfs": 1200,
    "failedDownloads": 50,
    "noPdfUrl": 100
  }
}
```

### Test Coverage
- 50 tests covering:
  - AMC list parsing (5 tests)
  - Scheme list parsing (4 tests)
  - PDF URL extraction (6 tests)
  - Download with retry (4 tests)
  - Download pool concurrency (5 tests)
  - State persistence (10 tests)
  - State manager (8 tests)
  - Scraper integration (8 tests)

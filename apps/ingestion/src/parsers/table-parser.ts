/**
 * Table extraction wrapper using pdfplumber via Python subprocess.
 *
 * This module provides a TypeScript interface to extract tables from PDFs
 * using the Python pdfplumber library.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "node:fs";

/**
 * A single extracted table from a PDF.
 */
export interface ExtractedTable {
  /** Page number (1-indexed) where the table was found */
  page: number;
  /** Index of the table within the page (0-indexed) */
  tableIndex: number;
  /** Raw table data as array of rows, each row is array of cell strings */
  rows: string[][];
  /** Table formatted as markdown */
  markdown: string;
}

/**
 * Result of table extraction operation.
 */
export interface TableExtractionResult {
  /** Array of extracted tables */
  tables: ExtractedTable[];
  /** Error message if extraction failed */
  error?: string;
}

export interface TableExtractionOptions {
  readonly page?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

/**
 * Get the path to the project root directory.
 */
function getProjectRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "../../../..");
}

/**
 * Get the path to the Python extraction script.
 */
function getPythonScriptPath(): string {
  return resolve(getProjectRoot(), "python/table_extractor/extract.py");
}

/**
 * Get the path to the Python executable, preferring venv if available.
 */
function getPythonExecutable(): string {
  const projectRoot = getProjectRoot();
  const venvPython = resolve(projectRoot, ".venv/bin/python3");

  if (existsSync(venvPython)) {
    return venvPython;
  }

  // Fallback to system Python
  return "python3";
}

/**
 * Extract tables from a PDF file using pdfplumber.
 *
 * @param filepath - Absolute path to the PDF file
 * @param page - Optional specific page number (1-indexed) to extract from
 * @returns Promise resolving to extraction result with tables array
 *
 * @example
 * ```typescript
 * const result = await extractTables("/path/to/document.pdf");
 * for (const table of result.tables) {
 *   console.log(`Page ${table.page}: ${table.rows.length} rows`);
 *   console.log(table.markdown);
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Extract from specific page
 * const result = await extractTables("/path/to/document.pdf", 5);
 * ```
 */
export async function extractTables(
  filepath: string,
  pageOrOptions: number | TableExtractionOptions = {},
): Promise<TableExtractionResult> {
  const options: TableExtractionOptions = typeof pageOrOptions === "number"
    ? { page: pageOrOptions }
    : pageOrOptions;
  options.signal?.throwIfAborted();
  const scriptPath = getPythonScriptPath();
  const pythonExe = getPythonExecutable();

  // Build command arguments
  const args = [pythonExe, scriptPath, filepath];
  if (options.page !== undefined) {
    args.push("--page", options.page.toString());
  }

  try {
    // Use Bun's shell for subprocess execution
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const abort = () => proc.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      const maxOutputBytes = options.maxOutputBytes ?? 10_000_000;
      const [exitCode, stdoutText, stderrText] = await Promise.all([
        proc.exited,
        readLimited(proc.stdout, maxOutputBytes, abort),
        readLimited(proc.stderr, Math.min(maxOutputBytes, 65_536), abort),
      ]);
      options.signal?.throwIfAborted();

    // Log warnings from stderr (non-fatal)
      if (stderrText.trim()) console.warn("[table-parser] Python warnings:", stderrText.trim());

    // Parse JSON output
      if (exitCode !== 0) return { tables: [], error: `Python extractor exited with code ${exitCode}` };
      if (!stdoutText.trim()) return { tables: [], error: "No output from Python script" };

      try {
        return JSON.parse(stdoutText) as TableExtractionResult;
      } catch (parseError) {
        return {
          tables: [],
          error: `Failed to parse Python output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        };
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    return {
      tables: [],
      error: `Failed to execute Python script: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        onLimit();
        throw new Error(`Subprocess output exceeds limit ${maxBytes}.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Check if pdfplumber is available by testing the Python script.
 *
 * @returns Promise resolving to true if pdfplumber is available
 */
export async function isPdfplumberAvailable(): Promise<boolean> {
  const pythonExe = getPythonExecutable();

  try {
    const proc = Bun.spawn(
      [pythonExe, "-c", "import pdfplumber; print('ok')"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    await proc.exited;
    const output = await new Response(proc.stdout).text();
    return output.trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * Format a table as a markdown string with optional title.
 *
 * @param table - The extracted table to format
 * @param title - Optional title to prepend
 * @returns Formatted markdown string
 */
export function formatTableAsMarkdown(
  table: ExtractedTable,
  title?: string
): string {
  const lines: string[] = [];

  if (title) {
    lines.push(`**${title}**`);
    lines.push("");
  }

  lines.push(table.markdown);

  return lines.join("\n");
}

/**
 * Wrap table content with markers for downstream processing.
 *
 * @param table - The extracted table
 * @returns Table markdown wrapped with [TABLE_START] and [TABLE_END] markers
 */
export function wrapTableWithMarkers(table: ExtractedTable): string {
  return `[TABLE_START]\n${table.markdown}\n[TABLE_END]`;
}

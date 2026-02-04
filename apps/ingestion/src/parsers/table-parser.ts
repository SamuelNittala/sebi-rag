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
  page?: number
): Promise<TableExtractionResult> {
  const scriptPath = getPythonScriptPath();
  const pythonExe = getPythonExecutable();

  // Build command arguments
  const args = [pythonExe, scriptPath, filepath];
  if (page !== undefined) {
    args.push("--page", page.toString());
  }

  try {
    // Use Bun's shell for subprocess execution
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for process to complete
    const exitCode = await proc.exited;

    // Read stdout and stderr
    const stdoutText = await new Response(proc.stdout).text();
    const stderrText = await new Response(proc.stderr).text();

    // Log warnings from stderr (non-fatal)
    if (stderrText.trim()) {
      console.warn("[table-parser] Python warnings:", stderrText.trim());
    }

    // Parse JSON output
    if (!stdoutText.trim()) {
      return {
        tables: [],
        error: "No output from Python script",
      };
    }

    try {
      const result = JSON.parse(stdoutText) as TableExtractionResult;
      return result;
    } catch (parseError) {
      return {
        tables: [],
        error: `Failed to parse Python output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }
  } catch (error) {
    return {
      tables: [],
      error: `Failed to execute Python script: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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

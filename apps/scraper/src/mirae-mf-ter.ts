#!/usr/bin/env bun

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const BASE_URL = "https://www.miraeassetmf.co.in";
const CATALOG_URL = `${BASE_URL}/AjaxService/GetDownloadsData`;
const LANDING_URL = `${BASE_URL}/downloads/statutory-disclosure/total-expense-ratio`;
const MINIMUM_SCHEMES = 50;
const MAXIMUM_SCHEMES = 200;

interface TerCatalogRow { Id: string; Title: string; URL: string; }

export function buildCurrentTerMarkdown(
  csv: string,
  artifactUrl: string,
  scrapedAt = new Date().toISOString(),
): { readonly markdown: string; readonly asOf: string; readonly schemeCount: number } {
  const records = parseCsv(csv);
  if (records.length < 3) throw new Error("TER workbook has no data rows.");
  const data = records.slice(2).filter((row) => row.length >= 13 && row[0] && row[1] && row[2]);
  const dated = data.map((row) => ({ row, date: parseUsDate(row[2]!) }));
  const latest = dated.reduce((value, item) => item.date > value ? item.date : value, "");
  const current = dated.filter(({ date }) => date === latest).sort((a, b) => a.row[1]!.localeCompare(b.row[1]!));
  if (current.length < MINIMUM_SCHEMES || current.length > MAXIMUM_SCHEMES) {
    throw new Error(`TER workbook returned ${current.length} current schemes; expected ${MINIMUM_SCHEMES}-${MAXIMUM_SCHEMES}.`);
  }
  const names = new Set(current.map(({ row }) => row[1]));
  if (names.size !== current.length) throw new Error("TER workbook contains duplicate current rows for a scheme.");

  const frontmatter = [
    "---",
    `title: "Mirae Asset Mutual Fund Total Expense Ratios as of ${latest}"`,
    `source_url: "${LANDING_URL}"`,
    "content_category: regulatory",
    "source: mirae-mf-ter",
    `scraped_at: "${scrapedAt}"`,
    `source_date: "${latest}"`,
    `source_artifact_url: "${artifactUrl}"`,
    "---",
  ].join("\n");
  const body = current.map(({ row }) => [
    `## ${row[1]}`,
    "",
    `NSDL scheme code: ${row[0]}`,
    `Effective date: ${latest}`,
    `Regular Plan total expense ratio (TER): ${row[7]}`,
    `Direct Plan total expense ratio (TER): ${row[12]}`,
    `Regular Plan base expense ratio: ${row[3]}`,
    `Direct Plan base expense ratio: ${row[8]}`,
  ].join("\n")).join("\n\n");
  return { markdown: `${frontmatter}\n\n${body}\n`, asOf: latest, schemeCount: current.length };
}

export async function refreshMiraeMfTer(): Promise<void> {
  const catalog = await fetch(CATALOG_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ request: {
      modulename: "TotalExpenseRatio", title: "", fromdate: "", todate: "", pgno: 1, pgsize: 1,
    } }),
  });
  if (!catalog.ok) throw new Error(`TER catalogue returned HTTP ${catalog.status}.`);
  const payload = await catalog.json() as { ReturnCode?: string; Data?: TerCatalogRow[] };
  const latest = payload.ReturnCode === "0" ? payload.Data?.[0] : undefined;
  if (!latest || !/^[A-Za-z0-9-]{1,80}$/.test(latest.Id) || !latest.URL) {
    throw new Error("TER catalogue did not return a valid latest workbook.");
  }
  const artifactUrl = new URL(latest.URL, BASE_URL);
  if (artifactUrl.origin !== BASE_URL || !artifactUrl.pathname.toLowerCase().endsWith(".xls")) {
    throw new Error("TER catalogue returned an unexpected workbook URL.");
  }
  const workbookResponse = await fetch(artifactUrl);
  if (!workbookResponse.ok) throw new Error(`TER workbook returned HTTP ${workbookResponse.status}.`);
  const bytes = new Uint8Array(await workbookResponse.arrayBuffer());
  if (bytes.byteLength < 8 || bytes.byteLength > 10 * 1024 * 1024) throw new Error("TER workbook size is outside safe bounds.");

  const rawDir = resolve(import.meta.dir, "../../..", "data/structured-sources/mirae-mf-ter");
  const markdownDir = resolve(import.meta.dir, "../../..", "data/html-sources/mirae-mf-ter");
  await Promise.all([mkdir(rawDir, { recursive: true }), mkdir(markdownDir, { recursive: true })]);
  const workbookPath = join(rawDir, basename(artifactUrl.pathname));
  await Bun.write(workbookPath, bytes);
  const conversionDir = await mkdtemp(join(tmpdir(), "mirae-ter-"));
  try {
    const process = Bun.spawn([
      "libreoffice", "--headless", "--convert-to", "csv", "--outdir", conversionDir, workbookPath,
    ], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await process.exited;
    if (exitCode !== 0) throw new Error(`LibreOffice TER conversion failed with exit code ${exitCode}.`);
    const csvPath = join(conversionDir, basename(workbookPath, ".xls") + ".csv");
    const built = buildCurrentTerMarkdown(await Bun.file(csvPath).text(), artifactUrl.href);
    await Bun.write(join(markdownDir, "current-ter.md"), built.markdown);
    console.log(`Wrote ${built.schemeCount} current TER facts as of ${built.asOf}.`);
  } finally {
    await rm(conversionDir, { recursive: true, force: true });
  }
}

function parseUsDate(value: string): string {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new Error(`TER workbook contains invalid date '${value}'.`);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`TER workbook contains invalid date '${value}'.`);
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === '"' && value[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("TER CSV contains an unterminated quoted field.");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

if (import.meta.main) {
  await refreshMiraeMfTer();
}

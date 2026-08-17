import {
  createLogicalDocumentKey,
  type SourceDiscoveryConfig,
} from "@mf-rag/types";

import {
  deterministicSourceConnectorError as deterministic,
  isPdfDocumentUrl,
  type DiscoveredSourceDocument,
} from "./source-connector.ts";

type CatalogConfig = Extract<SourceDiscoveryConfig, { strategy: "mirae_mf_download_catalog" }>;
type PostJson = (url: string, payload: unknown, signal?: AbortSignal) => Promise<string>;
type AssertAllowedDocumentUrl = (url: string) => string;

interface CatalogRow {
  readonly Id: string;
  readonly URL: string;
}

export async function discoverMiraeMfDownloadCatalog(
  config: CatalogConfig,
  postJson: PostJson,
  assertAllowedDocumentUrl: AssertAllowedDocumentUrl,
  signal?: AbortSignal,
): Promise<readonly DiscoveredSourceDocument[]> {
  const documents = new Map<string, DiscoveredSourceDocument>();
  let page = 1;
  let totalPages = 1;

  do {
    if (page > config.maxPages) {
      throw deterministic("CATALOG_PAGE_LIMIT", `Catalogue exceeded the configured ${config.maxPages}-page limit.`);
    }
    const response = parseResponse(await postJson(config.catalogUrl, {
      request: {
        modulename: config.moduleName,
        title: "",
        fromdate: config.fromDate ?? "",
        todate: config.toDate ?? "",
        pgno: page,
        pgsize: config.pageSize,
      },
    }, signal));
    totalPages = Math.max(1, Math.ceil(response.count / config.pageSize));
    for (const row of response.rows) {
      addDocument(documents, row, config, assertAllowedDocumentUrl);
    }
    page += 1;
  } while (page <= totalPages);

  if (documents.size < config.minimumDocuments) {
    throw deterministic(
      "CATALOG_DOCUMENT_MINIMUM",
      `Catalogue returned ${documents.size} PDF documents, below the configured minimum of ${config.minimumDocuments}.`,
    );
  }
  return [...documents.values()].sort((left, right) =>
    String(left.logicalDocumentKey).localeCompare(String(right.logicalDocumentKey)));
}

function parseResponse(value: string): { readonly count: number; readonly rows: readonly CatalogRow[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw deterministic("CATALOG_RESPONSE_INVALID", "Catalogue returned invalid JSON data.");
  }
  if (!isRecord(parsed) || parsed.ReturnCode !== "0" || !Number.isSafeInteger(parsed.DataCount)
    || Number(parsed.DataCount) < 0 || !Array.isArray(parsed.Data)) {
    throw deterministic("CATALOG_RESPONSE_INVALID", "Catalogue response has an invalid status, count, or data array.");
  }
  const rows = parsed.Data.map((row): CatalogRow => {
    if (!isRecord(row) || typeof row.Id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(row.Id)
      || typeof row.URL !== "string") {
      throw deterministic("CATALOG_DOCUMENT_INVALID", "Catalogue document requires a stable provider ID and URL.");
    }
    return { Id: row.Id, URL: row.URL };
  });
  return { count: Number(parsed.DataCount), rows };
}

function addDocument(
  documents: Map<string, DiscoveredSourceDocument>,
  row: CatalogRow,
  config: CatalogConfig,
  assertAllowedDocumentUrl: AssertAllowedDocumentUrl,
): void {
  const candidate = new URL(row.URL, config.catalogUrl);
  if (!isPdfDocumentUrl(candidate)) return;
  const url = assertAllowedDocumentUrl(candidate.href);
  const logicalDocumentKey = createLogicalDocumentKey(`catalog:${row.Id}`);
  const key = String(logicalDocumentKey);
  const existing = documents.get(key);
  if (existing && existing.url !== url) {
    throw deterministic("CATALOG_ID_CONFLICT", `Catalogue identity ${key} resolves to multiple PDF URLs.`);
  }
  documents.set(key, { logicalDocumentKey, url });
  if (documents.size > config.maxDocuments) {
    throw deterministic("CATALOG_DOCUMENT_LIMIT", `Catalogue exceeded the configured ${config.maxDocuments}-document limit.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

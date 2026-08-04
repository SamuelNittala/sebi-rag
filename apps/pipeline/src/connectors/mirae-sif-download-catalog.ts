import {
  createLogicalDocumentKey,
  type SourceDiscoveryConfig,
} from "@mf-rag/types";

import {
  deterministicSourceConnectorError as deterministic,
  isPdfDocumentUrl,
  type DiscoveredSourceDocument,
} from "./source-connector.ts";

type CatalogConfig = Extract<SourceDiscoveryConfig, { strategy: "mirae_sif_download_catalog" }>;
type FetchText = (url: string, accept: string, signal?: AbortSignal) => Promise<string>;
type AssertAllowedDocumentUrl = (url: string) => string;

interface CatalogTarget {
  readonly section: string;
  readonly subsection: string;
  readonly endpoint: "download-forms-sub" | "ter";
}

export async function discoverMiraeSifDownloadCatalog(
  config: CatalogConfig,
  fetchText: FetchText,
  assertAllowedDocumentUrl: AssertAllowedDocumentUrl,
  signal?: AbortSignal,
): Promise<readonly DiscoveredSourceDocument[]> {
  const html = await fetchText(config.catalogUrl, "text/html,application/xhtml+xml", signal);
  const targets = extractCatalogTargets(html, config.additionalTargets);
  const documents = new Map<string, DiscoveredSourceDocument>();
  let fetchedPages = 0;

  for (const target of targets) {
    let page = 1;
    let totalPages = 1;
    do {
      fetchedPages += 1;
      if (fetchedPages > config.maxPages) {
        throw deterministic("CATALOG_PAGE_LIMIT", `Catalogue exceeded the configured ${config.maxPages}-page limit.`);
      }
      const response = await fetchText(
        catalogApiUrl(config, target, page),
        "application/json",
        signal,
      );
      const groups = parseCatalogGroups(response, target);
      totalPages = Math.max(totalPages, ...groups.map(groupPageCount));
      for (const group of groups) {
        for (const item of catalogForms(group)) {
          addDocument(documents, item, config.maxDocuments, assertAllowedDocumentUrl);
        }
      }
      page += 1;
    } while (page <= totalPages);
  }

  if (documents.size < config.minimumDocuments) {
    throw deterministic(
      "CATALOG_DOCUMENT_MINIMUM",
      `Catalogue returned ${documents.size} PDF documents, below the configured minimum of ${config.minimumDocuments}.`,
    );
  }

  return [...documents.values()].sort((left, right) =>
    String(left.logicalDocumentKey).localeCompare(String(right.logicalDocumentKey)));
}

function extractCatalogTargets(
  html: string,
  additionalTargets: CatalogConfig["additionalTargets"],
): CatalogTarget[] {
  const normalized = html.replaceAll('\\"', '"');
  const marker = '"mainLinksData":';
  const markerIndex = normalized.indexOf(marker);
  const objectStart = markerIndex < 0 ? -1 : normalized.indexOf("{", markerIndex + marker.length);
  if (objectStart < 0) throw deterministic("CATALOG_SECTIONS_MISSING", "Catalogue section metadata was not found.");

  const mainLinksData = parseJsonObject(extractJsonObject(normalized, objectStart), "CATALOG_SECTIONS_INVALID");
  if (!isRecord(mainLinksData)) {
    throw deterministic("CATALOG_SECTIONS_INVALID", "Catalogue section metadata is not an object.");
  }
  const mainLinks = recordArray(mainLinksData, "mainLinks", "CATALOG_SECTIONS_INVALID");
  const advertisedSections = new Set<string>();
  const targets = mainLinks.flatMap((section): CatalogTarget[] => {
    const sectionSlug = catalogSlug(section, "section");
    advertisedSections.add(sectionSlug);
    return recordArray(section, "sideLinks", "CATALOG_SECTIONS_INVALID").map((subsection) => ({
      section: sectionSlug,
      subsection: catalogSlug(subsection, "subsection"),
      endpoint: "download-forms-sub",
    }));
  });

  for (const additionalTarget of additionalTargets) {
    if (!advertisedSections.has(additionalTarget.section)) {
      throw deterministic(
        "CATALOG_ADDITIONAL_TARGET_PARENT_MISSING",
        `Additional catalogue target ${additionalTarget.section}/${additionalTarget.subsection} has no advertised parent section.`,
      );
    }
    const existing = targets.find(({ section, subsection }) => (
      section === additionalTarget.section && subsection === additionalTarget.subsection
    ));
    if (existing && existing.endpoint !== additionalTarget.endpoint) {
      throw deterministic(
        "CATALOG_TARGET_CONFLICT",
        `Catalogue target ${additionalTarget.section}/${additionalTarget.subsection} resolves to multiple endpoints.`,
      );
    }
    if (!existing) targets.push(additionalTarget);
  }
  if (targets.length === 0) throw deterministic("CATALOG_SECTIONS_MISSING", "Catalogue advertises no sections or subsections.");
  return targets;
}

function catalogApiUrl(config: CatalogConfig, target: CatalogTarget, page: number): string {
  const endpointParameters = new URLSearchParams();
  if (target.endpoint === "ter") {
    endpointParameters.set("page", String(page));
    endpointParameters.set("rows", String(config.pageSize));
  } else {
    endpointParameters.set("mainLink", target.section);
    endpointParameters.set("sideLink", target.subsection);
    endpointParameters.set("pageNo", String(page));
    endpointParameters.set("NoOfRows", String(config.pageSize));
  }

  const apiUrl = new URL("/api/sif-dynamic-get", config.catalogUrl);
  apiUrl.searchParams.set("endpoint", `${target.endpoint}?${endpointParameters}`);
  apiUrl.searchParams.set("noCache", "true");
  return apiUrl.href;
}

function parseCatalogGroups(response: string, target: CatalogTarget): readonly Record<string, unknown>[] {
  const decoded = parseJsonObject(response, "CATALOG_RESPONSE_INVALID");
  const roots = Array.isArray(decoded) ? decoded : [decoded];
  return roots.flatMap((root): readonly Record<string, unknown>[] => {
    if (!isRecord(root)) throw deterministic("CATALOG_RESPONSE_INVALID", "Catalogue response is not an object.");
    if (target.endpoint === "ter" && Array.isArray(root.forms)) return [root];
    if (!Array.isArray(root.children)) {
      throw deterministic("CATALOG_RESPONSE_INVALID", "Catalogue response has no document groups.");
    }
    return root.children.map((group) => {
      if (!isRecord(group)) throw deterministic("CATALOG_RESPONSE_INVALID", "Catalogue document group is invalid.");
      return group;
    });
  });
}

function addDocument(
  documents: Map<string, DiscoveredSourceDocument>,
  item: unknown,
  maxDocuments: number,
  assertAllowedDocumentUrl: AssertAllowedDocumentUrl,
): void {
  if (!isRecord(item)) throw deterministic("CATALOG_DOCUMENT_INVALID", "Catalogue document entry is not an object.");
  const providerId = typeof item.id === "string"
    ? item.id
    : typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id >= 0
      ? String(item.id)
      : "";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(providerId) || typeof item.link !== "string") {
    throw deterministic("CATALOG_DOCUMENT_INVALID", "Catalogue document requires a stable provider ID and URL.");
  }

  let parsed: URL;
  try { parsed = new URL(item.link); } catch {
    throw deterministic("CATALOG_DOCUMENT_INVALID", "Catalogue document URL is invalid.");
  }
  if (!isPdfDocumentUrl(parsed)) return;

  const url = assertAllowedDocumentUrl(parsed.href);
  const logicalDocumentKey = createLogicalDocumentKey(`catalog:${providerId}`);
  const key = String(logicalDocumentKey);
  const existing = documents.get(key);
  if (existing && existing.url !== url) {
    throw deterministic("CATALOG_ID_CONFLICT", `Catalogue identity ${key} resolves to multiple PDF URLs.`);
  }
  documents.set(key, { logicalDocumentKey, url });
  if (documents.size > maxDocuments) {
    throw deterministic("CATALOG_DOCUMENT_LIMIT", `Catalogue exceeded the configured ${maxDocuments}-document limit.`);
  }
}

function catalogForms(group: Record<string, unknown>): readonly unknown[] {
  if (!Array.isArray(group.forms)) {
    throw deterministic("CATALOG_RESPONSE_INVALID", "Catalogue document group has no forms array.");
  }
  return group.forms;
}

function groupPageCount(group: Record<string, unknown>): number {
  const value = group.totalPages ?? 1;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw deterministic("CATALOG_RESPONSE_INVALID", "Catalogue document group has an invalid page count.");
  }
  return Number(value);
}

function recordArray(record: Record<string, unknown>, key: string, code: string): readonly Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) throw deterministic(code, `Catalogue ${key} must be an array.`);
  return value.map((entry) => {
    if (!isRecord(entry)) throw deterministic(code, `Catalogue ${key} contains an invalid entry.`);
    return entry;
  });
}

function catalogSlug(record: Record<string, unknown>, label: string): string {
  if (typeof record.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.slug)) {
    throw deterministic("CATALOG_SECTIONS_INVALID", `Catalogue ${label} has an invalid slug.`);
  }
  return record.slug;
}

function extractJsonObject(value: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return value.slice(start, index + 1);
  }
  throw deterministic("CATALOG_SECTIONS_INVALID", "Catalogue section metadata is truncated.");
}

function parseJsonObject(value: string, code: string): unknown {
  try { return JSON.parse(value); } catch {
    throw deterministic(code, "Catalogue returned invalid JSON data.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

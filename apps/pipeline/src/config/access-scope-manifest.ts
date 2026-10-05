import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createAccessScopeKey,
  createExternalAccessCode,
  createLogicalDocumentKey,
  createSourceKey,
  findInlineSecretField,
  sourceConnectorKinds,
  sourceDocumentTypes,
  sourceParsers,
  type AccessScopeManifest,
  type DesiredSourceRegistry,
  type SourceDiscoveryConfig,
  type SourceManifest,
} from "@mf-rag/types";
import { parseExpression } from "cron-parser";
import { parseDocument } from "yaml";
import { z } from "zod";

const secretReferenceSchema = z.string().regex(
  /^[A-Z][A-Z0-9_]{2,127}$/,
  "secretRef must name a deployment-managed secret using an uppercase identifier.",
);

const safeUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "URLs must use HTTP or HTTPS." });
  }
  if (url.username || url.password) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "URLs must not contain inline credentials.",
    });
  }
  if (url.search) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Configured discovery URLs must not contain query parameters; discover tokenized URLs at runtime.",
    });
  }
});

const explicitUrlsSchema = z.object({
  strategy: z.literal("explicit_urls"),
  urls: z.array(z.object({
    key: z.string().transform((value, context) => {
      try { return createLogicalDocumentKey(value); } catch (error) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
        return z.NEVER;
      }
    }),
    url: safeUrlSchema,
  }).strict()).max(1000),
}).strict();

const normalizedPathIdentitySchema = z.object({
  strategy: z.literal("normalized_path"),
  queryParameters: z.array(z.string().regex(/^[A-Za-z0-9._~-]+$/).superRefine((value, context) => {
    if (/^(?:token|access[_-]?token|api[_-]?key|signature|sig|credential|x-amz-.+)$/i.test(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Secret-bearing query parameters must not participate in document identity.",
      });
    }
  })).max(20).default([]),
}).strict();

const sitemapSchema = z.object({
  strategy: z.literal("sitemap"),
  sitemapUrls: z.array(safeUrlSchema),
  includePathPrefixes: z.array(z.string().startsWith("/")),
  maxDocuments: z.number().int().min(1).max(10_000),
  identity: normalizedPathIdentitySchema,
}).strict();

const constrainedCrawlSchema = z.object({
  strategy: z.literal("constrained_crawl"),
  startUrls: z.array(safeUrlSchema),
  allowedPathPrefixes: z.array(z.string().startsWith("/")),
  maxDepth: z.number().int().min(0).max(5),
  maxPages: z.number().int().min(1).max(1000),
  maxDocuments: z.number().int().min(1).max(10_000),
  identity: normalizedPathIdentitySchema,
}).strict();

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD.");

const miraeMfDownloadCatalogSchema = z.object({
  strategy: z.literal("mirae_mf_download_catalog"),
  catalogUrl: safeUrlSchema,
  moduleName: z.enum(["Addendum", "Factsheet", "Application_Form&KIM"]),
  fromDate: isoDateSchema.optional(),
  toDate: isoDateSchema.optional(),
  pageSize: z.number().int().min(1).max(1000),
  maxPages: z.number().int().min(1).max(1000),
  maxDocuments: z.number().int().min(1).max(10_000),
  minimumDocuments: z.number().int().min(1).max(10_000),
}).strict();

const miraeSifDownloadCatalogSchema = z.object({
  strategy: z.literal("mirae_sif_download_catalog"),
  catalogUrl: safeUrlSchema,
  sections: z.literal("all"),
  additionalTargets: z.array(z.object({
    section: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    subsection: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    endpoint: z.enum(["download-forms-sub", "ter"]),
  }).strict()).max(100),
  pageSize: z.number().int().min(1).max(500),
  maxPages: z.number().int().min(1).max(10_000),
  maxDocuments: z.number().int().min(1).max(10_000),
  minimumDocuments: z.number().int().min(1).max(10_000),
}).strict();

const sebiSidScraperSchema = z.object({
  strategy: z.literal("sebi_sid_scraper"),
  mfId: z.string().regex(/^\d+$/, "SEBI mfId must be numeric"),
  maxSchemes: z.number().int().min(1).max(10_000),
  maxDocuments: z.number().int().min(1).max(10_000),
  minimumDocuments: z.number().int().min(1).max(10_000),
}).strict();

const discoverySchema = z.discriminatedUnion("strategy", [
  explicitUrlsSchema,
  sitemapSchema,
  constrainedCrawlSchema,
  miraeMfDownloadCatalogSchema,
  miraeSifDownloadCatalogSchema,
  sebiSidScraperSchema,
]);

const scheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string().superRefine(validateCron),
  timezone: z.string().superRefine(validateTimezone),
}).strict();

const fetchSchema = z.object({
  secretRef: secretReferenceSchema.optional(),
  allowedHosts: z.array(z.string().regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/)).min(1),
  allowedPathPrefixes: z.array(z.string().startsWith("/")).min(1),
  maxBytes: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxRedirects: z.number().int().min(0).max(10),
}).strict();

// Sent verbatim (JSON array) in the Docling `X-Fund-Name-Prefixes` header, so
// prefixes stay printable ASCII without characters JSON or HTTP would escape.
const fundNamePrefixesSchema = z.array(z.string().min(2).max(64)
  .regex(/^[A-Za-z0-9&.'-](?:[A-Za-z0-9 &.'-]*[A-Za-z0-9&.'-])?$/, {
    message: "Fund-name prefixes allow letters, digits, spaces and & . ' - without leading or trailing spaces.",
  })).min(1).max(8).superRefine((prefixes, context) => {
  const duplicate = findDuplicate(prefixes);
  if (duplicate) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate fund-name prefix: ${duplicate}` });
});

const sourceSchema = z.object({
  key: z.string(),
  connector: z.enum(sourceConnectorKinds),
  enabled: z.boolean(),
  discovery: discoverySchema,
  schedule: scheduleSchema,
  fetch: fetchSchema,
  review: z.object({
    policy: z.literal("risk_based"),
  }).strict(),
  parse: z.object({
    parser: z.enum(sourceParsers),
    fundNamePrefixes: fundNamePrefixesSchema.optional(),
  }).strict().optional(),
  documentType: z.enum(sourceDocumentTypes).optional(),
}).strict().superRefine((source, context) => {
  if (source.discovery.strategy === "explicit_urls") {
    const duplicateKey = findDuplicate(source.discovery.urls.map(({ key }) => String(key)));
    const duplicateUrl = findDuplicate(source.discovery.urls.map(({ url }) => url));
    if (duplicateKey) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate pinned document key: ${duplicateKey}`, path: ["discovery", "urls"] });
    if (duplicateUrl) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate explicit document URL: ${duplicateUrl}`, path: ["discovery", "urls"] });
  }
  if (source.discovery.strategy === "mirae_sif_download_catalog") {
    if (source.discovery.minimumDocuments > source.discovery.maxDocuments) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimumDocuments must not exceed maxDocuments.",
        path: ["discovery", "minimumDocuments"],
      });
    }
    const duplicate = findDuplicate(source.discovery.additionalTargets.map((target) => (
      `${target.section}:${target.subsection}`
    )));
    if (duplicate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate additional catalogue target: ${duplicate}`,
        path: ["discovery", "additionalTargets"],
      });
    }
  }
  if (source.discovery.strategy === "mirae_mf_download_catalog") {
    if (source.discovery.minimumDocuments > source.discovery.maxDocuments) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimumDocuments must not exceed maxDocuments.",
        path: ["discovery", "minimumDocuments"],
      });
    }
    if (source.discovery.fromDate && source.discovery.toDate
      && source.discovery.fromDate > source.discovery.toDate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fromDate must not be after toDate.",
        path: ["discovery", "fromDate"],
      });
    }
  }
  if (source.discovery.strategy === "sebi_sid_scraper") {
    if (source.discovery.minimumDocuments > source.discovery.maxDocuments) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimumDocuments must not exceed maxDocuments.",
        path: ["discovery", "minimumDocuments"],
      });
    }
  }
  if (!source.enabled) {
    return;
  }
  if (discoveryTargets(source.discovery).length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An enabled source requires at least one discovery target.",
      path: ["discovery"],
    });
  }
});

const manifestSchema = z.object({
  apiVersion: z.literal("mf-rag/v1"),
  kind: z.literal("AccessScope"),
  metadata: z.object({
    key: z.string(),
    externalCode: z.string(),
  }).strict(),
  ownership: z.object({
    visibilityScope: z.literal("TENANT"),
    tenantId: z.string(),
  }).strict(),
  classification: z.object({
    knowledgeDomain: z.enum(["mutual_fund", "sif"]),
    sourceCollection: z.enum([
      "default_corpus",
      "mirae_mf",
      "mirae_sif",
      "sebi_regulatory",
      "general_mf_faq",
      "axis_mf",
    ]),
    amcSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullable(),
  }).strict(),
  sources: z.array(sourceSchema),
}).strict().superRefine((manifest, context) => {
  if (manifest.ownership.tenantId !== manifest.metadata.externalCode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "TENANT ownership tenantId must equal metadata.externalCode.",
      path: ["ownership", "tenantId"],
    });
  }

  const duplicate = findDuplicate(manifest.sources.map((source) => source.key));
  if (duplicate) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate source key: ${duplicate}`,
      path: ["sources"],
    });
  }
});

type ParsedManifest = z.infer<typeof manifestSchema>;

export function parseAccessScopeManifestYaml(
  yaml: string,
  origin = "access-scope manifest",
): AccessScopeManifest {
  const document = parseDocument(yaml, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${origin}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }

  const raw: unknown = document.toJS();
  const inlineSecretField = findInlineSecretField(raw);
  if (inlineSecretField) {
    throw new Error(`${origin}: inline secret field '${inlineSecretField}' is forbidden; use secretRef.`);
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${origin}: invalid manifest: ${formatIssues(parsed.error)}`);
  }

  return deepFreeze(toAccessScopeManifest(parsed.data));
}

export async function loadAccessScopeManifests(
  directory: string | URL,
): Promise<DesiredSourceRegistry> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (entries.length === 0) {
    throw new Error("No access-scope manifests found; refusing an empty desired state.");
  }

  const parsed = await Promise.all(entries.map(async (fileName) => {
    const filePath = directory instanceof URL
      ? new URL(fileName, ensureTrailingSlash(directory))
      : join(directory, fileName);
    const yaml = await Bun.file(filePath).text();
    return parseAccessScopeManifestYaml(yaml, fileName);
  }));

  assertUniqueRegistryIdentities(parsed);
  return deepFreeze({ version: 1, accessScopes: parsed });
}

function toAccessScopeManifest(manifest: ParsedManifest): AccessScopeManifest {
  const externalCode = createExternalAccessCode(manifest.metadata.externalCode);

  return {
    apiVersion: manifest.apiVersion,
    accessScopeKey: createAccessScopeKey(manifest.metadata.key),
    externalCode,
    classification: manifest.classification,
    sources: manifest.sources.map(toSourceManifest),
  };
}

function toSourceManifest(source: ParsedManifest["sources"][number]): SourceManifest {
  return {
    sourceKey: createSourceKey(source.key),
    connector: source.connector,
    enabled: source.enabled,
    discovery: source.discovery,
    schedule: source.schedule,
    fetch: source.fetch,
    review: source.review,
    ...(source.parse ? { parse: source.parse } : {}),
    ...(source.documentType ? { documentType: source.documentType } : {}),
  };
}

function assertUniqueRegistryIdentities(manifests: readonly AccessScopeManifest[]): void {
  const duplicateKey = findDuplicate(manifests.map((manifest) => manifest.accessScopeKey));
  if (duplicateKey) {
    throw new Error(`Duplicate access-scope key: ${duplicateKey}`);
  }

  const duplicateCode = findDuplicate(manifests.map((manifest) => manifest.externalCode));
  if (duplicateCode) {
    throw new Error(`Duplicate external code: ${duplicateCode}`);
  }
}

function validateCron(value: string, context: z.RefinementCtx): void {
  try {
    parseExpression(value, { tz: "UTC" });
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid cron expression." });
  }
}

function validateTimezone(value: string, context: z.RefinementCtx): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid IANA timezone." });
  }
}

function discoveryTargets(discovery: SourceDiscoveryConfig): readonly string[] {
  switch (discovery.strategy) {
    case "explicit_urls":
      return discovery.urls.map((target) => target.url);
    case "sitemap":
      return discovery.sitemapUrls;
    case "constrained_crawl":
      return discovery.startUrls;
    case "mirae_mf_download_catalog":
      return [discovery.catalogUrl];
    case "mirae_sif_download_catalog":
      return [discovery.catalogUrl];
    case "sebi_sid_scraper":
      return [`https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doGetFundDetails=yes&type=2&mfId=${discovery.mfId}`];
  }
}

function findDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return null;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
    .join("; ");
}

function ensureTrailingSlash(url: URL): URL {
  return url.pathname.endsWith("/") ? url : new URL(`${url.href}/`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

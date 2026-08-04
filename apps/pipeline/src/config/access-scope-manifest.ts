import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createAccessScopeKey,
  createExternalAccessCode,
  createSourceKey,
  externalAccessCodeToTenantId,
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
  if (url.username || url.password) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "URLs must not contain inline credentials.",
    });
  }
});

const explicitUrlsSchema = z.object({
  strategy: z.literal("explicit_urls"),
  urls: z.array(safeUrlSchema),
}).strict();

const sitemapSchema = z.object({
  strategy: z.literal("sitemap"),
  sitemapUrls: z.array(safeUrlSchema),
  includePathPrefixes: z.array(z.string().startsWith("/")),
}).strict();

const constrainedCrawlSchema = z.object({
  strategy: z.literal("constrained_crawl"),
  startUrls: z.array(safeUrlSchema),
  allowedPathPrefixes: z.array(z.string().startsWith("/")),
  maxDepth: z.number().int().min(0).max(5),
}).strict();

const discoverySchema = z.discriminatedUnion("strategy", [
  explicitUrlsSchema,
  sitemapSchema,
  constrainedCrawlSchema,
]);

const scheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string().superRefine(validateCron),
  timezone: z.string().superRefine(validateTimezone),
}).strict();

const fetchSchema = z.object({
  secretRef: secretReferenceSchema.optional(),
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedPathPrefixes: z.array(z.string().startsWith("/")).min(1),
  maxBytes: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxRedirects: z.number().int().min(0).max(10),
}).strict();

const sourceSchema = z.object({
  key: z.string(),
  connector: z.literal("website_pdf"),
  enabled: z.boolean(),
  discovery: discoverySchema,
  schedule: scheduleSchema,
  fetch: fetchSchema,
  review: z.object({
    policy: z.literal("risk_based"),
  }).strict(),
}).strict().superRefine((source, context) => {
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
    sourceCollection: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
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

const FORBIDDEN_INLINE_SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "password",
  "token",
]);

export function parseAccessScopeManifestYaml(
  yaml: string,
  origin = "access-scope manifest",
): AccessScopeManifest {
  const document = parseDocument(yaml, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${origin}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }

  const raw: unknown = document.toJS();
  assertNoInlineSecrets(raw, origin);

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
    const yaml = await readFile(filePath, "utf8");
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
    tenantId: externalAccessCodeToTenantId(externalCode),
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

function assertNoInlineSecrets(value: unknown, origin: string, path: string[] = []): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInlineSecrets(entry, origin, [...path, String(index)]));
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (FORBIDDEN_INLINE_SECRET_KEYS.has(normalizedKey)) {
      throw new Error(`${origin}: inline secret field '${[...path, key].join(".")}' is forbidden; use secretRef.`);
    }
    assertNoInlineSecrets(child, origin, [...path, key]);
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
      return discovery.urls;
    case "sitemap":
      return discovery.sitemapUrls;
    case "constrained_crawl":
      return discovery.startUrls;
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

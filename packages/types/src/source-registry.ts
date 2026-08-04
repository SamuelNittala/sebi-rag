import type { KnowledgeDomain, SourceCollection } from "./knowledge-scope.ts";
import { createTenantId, type TenantId } from "./tenant-access-scope.ts";

declare const accessScopeKeyBrand: unique symbol;
declare const externalAccessCodeBrand: unique symbol;
declare const sourceKeyBrand: unique symbol;
declare const logicalDocumentKeyBrand: unique symbol;

export type AccessScopeKey = string & { readonly [accessScopeKeyBrand]: true };
export type ExternalAccessCode = string & { readonly [externalAccessCodeBrand]: true };
export type SourceKey = string & { readonly [sourceKeyBrand]: true };
export type LogicalDocumentKey = string & { readonly [logicalDocumentKeyBrand]: true };

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const EXTERNAL_ACCESS_CODE_PATTERN = /^\d{1,20}$/;
const LOGICAL_DOCUMENT_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,198}[A-Za-z0-9])?$/;

export function createAccessScopeKey(value: string): AccessScopeKey {
  assertPattern(value, SLUG_PATTERN, "Access-scope key must be a canonical lowercase slug.");
  return value as AccessScopeKey;
}

export function createExternalAccessCode(value: string): ExternalAccessCode {
  assertPattern(value, EXTERNAL_ACCESS_CODE_PATTERN, "External access code must be a 1-20 digit string.");
  return value as ExternalAccessCode;
}

export function externalAccessCodeToTenantId(value: ExternalAccessCode): TenantId {
  return createTenantId(value);
}

export function createSourceKey(value: string): SourceKey {
  assertPattern(value, SLUG_PATTERN, "Source key must be a canonical lowercase slug.");
  return value as SourceKey;
}

export function createLogicalDocumentKey(value: string): LogicalDocumentKey {
  assertPattern(
    value,
    LOGICAL_DOCUMENT_KEY_PATTERN,
    "Logical document key must be a canonical 1-200 character identifier.",
  );
  return value as LogicalDocumentKey;
}

export const sourceConnectorKinds = ["website_pdf"] as const;
export type SourceConnectorKind = (typeof sourceConnectorKinds)[number];

export const discoveryStrategies = [
  "explicit_urls",
  "sitemap",
  "constrained_crawl",
] as const;
export type DiscoveryStrategy = (typeof discoveryStrategies)[number];

export interface ExplicitDocumentTarget {
  /** Human-owned identity. URL changes and redirects do not change this key. */
  readonly key: LogicalDocumentKey;
  readonly url: string;
}

export interface NormalizedPathIdentityRule {
  readonly strategy: "normalized_path";
  /** Query parameters not listed here are deliberately excluded from identity. */
  readonly queryParameters: readonly string[];
}

export type SourceDiscoveryConfig =
  | {
      readonly strategy: "explicit_urls";
      readonly urls: readonly ExplicitDocumentTarget[];
    }
  | {
      readonly strategy: "sitemap";
      readonly sitemapUrls: readonly string[];
      readonly includePathPrefixes: readonly string[];
      readonly maxDocuments: number;
      readonly identity: NormalizedPathIdentityRule;
    }
  | {
      readonly strategy: "constrained_crawl";
      readonly startUrls: readonly string[];
      readonly allowedPathPrefixes: readonly string[];
      readonly maxDepth: number;
      readonly maxPages: number;
      readonly maxDocuments: number;
      readonly identity: NormalizedPathIdentityRule;
    };

export interface SourceSchedule {
  readonly enabled: boolean;
  readonly cron: string;
  readonly timezone: string;
}

export interface SourceFetchConstraints {
  readonly secretRef?: string;
  readonly allowedHosts: readonly string[];
  readonly allowedPathPrefixes: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
}

export interface SourceReviewConfig {
  readonly policy: "risk_based";
}

export interface SourceManifest {
  readonly sourceKey: SourceKey;
  readonly connector: SourceConnectorKind;
  readonly enabled: boolean;
  readonly discovery: SourceDiscoveryConfig;
  readonly schedule: SourceSchedule;
  readonly fetch: SourceFetchConstraints;
  readonly review: SourceReviewConfig;
}

export interface AccessScopeClassification {
  readonly knowledgeDomain: KnowledgeDomain;
  readonly sourceCollection: SourceCollection;
  readonly amcSlug: string | null;
}

export interface AccessScopeManifest {
  readonly apiVersion: "mf-rag/v1";
  readonly accessScopeKey: AccessScopeKey;
  readonly externalCode: ExternalAccessCode;
  readonly classification: AccessScopeClassification;
  readonly sources: readonly SourceManifest[];
}

export interface DesiredSourceRegistry {
  readonly version: 1;
  readonly accessScopes: readonly AccessScopeManifest[];
}

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

export function findInlineSecretField(
  value: unknown,
  path: readonly string[] = [],
): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = findInlineSecretField(child, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (FORBIDDEN_INLINE_SECRET_KEYS.has(key.replace(/[-_]/g, "").toLowerCase())) {
      return childPath.join(".");
    }
    const found = findInlineSecretField(child, childPath);
    if (found) return found;
  }
  return null;
}

function assertPattern(value: string, pattern: RegExp, message: string): void {
  if (!pattern.test(value)) {
    throw new Error(message);
  }
}

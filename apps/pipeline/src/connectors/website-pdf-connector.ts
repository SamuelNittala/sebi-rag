import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  createLogicalDocumentKey,
  type LogicalDocumentKey,
  type NormalizedPathIdentityRule,
  type SourceDiscoveryConfig,
} from "@mf-rag/types";

import {
  deterministicSourceConnectorError as deterministic,
  isPdfDocumentUrl as isPdfUrl,
  SourceConnectorError,
  type DiscoveredSourceDocument,
  type FetchValidators,
  type SourceConnector,
  type SourceConnectorOptions,
  type SourceFetchResult,
} from "./source-connector.ts";
import { discoverMiraeSifDownloadCatalog } from "./mirae-sif-download-catalog.ts";

const PDF_SIGNATURE = new TextEncoder().encode("%PDF-");
const DEFAULT_HEADERS = { "user-agent": "mf-rag-document-pipeline/1.0" } as const;

export { SourceConnectorError } from "./source-connector.ts";

export class WebsitePdfConnector implements SourceConnector {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #allowedPathPrefixes: readonly string[];
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #resolveHost: (hostname: string) => Promise<readonly string[]>;
  readonly #allowPrivateAddresses: boolean;

  constructor(options: SourceConnectorOptions) {
    if (options.allowedHosts.length === 0 || options.allowedPathPrefixes.length === 0) {
      throw new Error("Website connector requires host and path allowlists.");
    }
    this.#allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.#allowedPathPrefixes = [...options.allowedPathPrefixes];
    this.#maxBytes = positiveInteger(options.maxBytes, "Maximum response bytes");
    this.#timeoutMs = positiveInteger(options.timeoutMs, "Fetch timeout");
    this.#maxRedirects = nonNegativeInteger(options.maxRedirects, "Maximum redirects");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#resolveHost = options.resolveHost ?? (async (hostname) =>
      (await lookup(hostname, { all: true })).map(({ address }) => address));
    this.#allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  }

  async discover(config: SourceDiscoveryConfig, signal?: AbortSignal): Promise<readonly DiscoveredSourceDocument[]> {
    switch (config.strategy) {
      case "explicit_urls":
        return config.urls.map(({ key, url }) => ({
          logicalDocumentKey: createLogicalDocumentKey(String(key)),
          url: this.#assertAllowed(url),
        }));
      case "sitemap":
        return this.#discoverSitemaps(config, signal);
      case "constrained_crawl":
        return this.#discoverCrawl(config, signal);
      case "mirae_sif_download_catalog":
        return discoverMiraeSifDownloadCatalog(
          config,
          (url, accept, requestSignal) => this.#fetchText(url, accept, requestSignal),
          (url) => this.#assertAllowed(url),
          signal,
        );
    }
  }

  async fetch(url: string, validators: FetchValidators = {}, signal?: AbortSignal): Promise<SourceFetchResult> {
    const requestedUrl = this.#assertAllowed(url);
    const headers = new Headers({ ...DEFAULT_HEADERS, accept: "application/pdf" });
    if (validators.etag) headers.set("if-none-match", validators.etag);
    if (validators.lastModified) headers.set("if-modified-since", validators.lastModified);
    const { response, canonicalUrl, aliases, timeoutSignal } = await this.#request(requestedUrl, headers, signal);
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");

    if (response.status === 304) {
      return { kind: "not_modified", requestedUrl, canonicalUrl, aliases, etag, lastModified };
    }
    this.#assertSuccessful(response);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/pdf") {
      throw deterministic("PAYLOAD_MEDIA_TYPE", `Expected application/pdf, received ${contentType ?? "no content type"}.`);
    }
    const bytes = await readBounded(response, this.#maxBytes, signal, timeoutSignal);
    if (bytes.byteLength < PDF_SIGNATURE.byteLength
      || PDF_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
      throw deterministic("PAYLOAD_SIGNATURE", "PDF payload does not begin with the %PDF- signature.");
    }
    return {
      kind: "fetched",
      requestedUrl,
      canonicalUrl,
      aliases,
      bytes,
      mediaType: "application/pdf",
      etag,
      lastModified,
    };
  }

  async #discoverSitemaps(
    config: Extract<SourceDiscoveryConfig, { strategy: "sitemap" }>,
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredSourceDocument[]> {
    const documents = new Map<string, DiscoveredSourceDocument>();
    for (const sitemapUrl of config.sitemapUrls) {
      const body = await this.#fetchText(sitemapUrl, "application/xml,text/xml,*/*", signal);
      for (const discoveredUrl of extractSitemapLocations(body)) {
        const normalized = normalizeDocumentUrl(new URL(discoveredUrl, sitemapUrl).href);
        const parsed = new URL(normalized);
        if (!isPdfUrl(parsed) || !hasAllowedPrefix(parsed.pathname, config.includePathPrefixes)) continue;
        const identityUrl = canonicalizeForIdentity(parsed, config.identity);
        this.#assertAllowed(identityUrl);
        documents.set(identityUrl, { logicalDocumentKey: derivePathKey(new URL(identityUrl), config.identity), url: identityUrl });
        if (documents.size >= config.maxDocuments) return sortedDocuments(documents);
      }
    }
    return sortedDocuments(documents);
  }

  async #discoverCrawl(
    config: Extract<SourceDiscoveryConfig, { strategy: "constrained_crawl" }>,
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredSourceDocument[]> {
    const queue = config.startUrls.map((url) => {
      const allowed = this.#assertAllowed(url);
      return { url: allowed, depth: 0, rootHostname: new URL(allowed).hostname.toLowerCase() };
    });
    const enqueued = new Set(queue.map(({ url }) => url));
    let queueIndex = 0;
    const visited = new Set<string>();
    const documents = new Map<string, DiscoveredSourceDocument>();
    while (queueIndex < queue.length && visited.size < config.maxPages && documents.size < config.maxDocuments) {
      const next = queue[queueIndex++];
      if (!next || visited.has(next.url)) continue;
      visited.add(next.url);
      const html = await this.#fetchText(next.url, "text/html,application/xhtml+xml", signal);
      for (const href of extractHtmlLinks(html)) {
        let normalized: string;
        try { normalized = normalizeDocumentUrl(new URL(href, next.url).href); } catch { continue; }
        const parsed = new URL(normalized);
        if (parsed.hostname.toLowerCase() !== next.rootHostname) continue;
        if (!hasAllowedPrefix(parsed.pathname, config.allowedPathPrefixes)) continue;
        this.#assertAllowed(normalized);
        if (isPdfUrl(parsed)) {
          const identityUrl = canonicalizeForIdentity(parsed, config.identity);
          documents.set(identityUrl, { logicalDocumentKey: derivePathKey(new URL(identityUrl), config.identity), url: identityUrl });
        } else if (next.depth < config.maxDepth
          && !enqueued.has(normalized)
          && queue.length - queueIndex < config.maxPages - visited.size) {
          enqueued.add(normalized);
          queue.push({ url: normalized, depth: next.depth + 1, rootHostname: next.rootHostname });
        }
        if (documents.size >= config.maxDocuments) break;
      }
    }
    return sortedDocuments(documents);
  }

  async #fetchText(url: string, accept: string, signal?: AbortSignal): Promise<string> {
    const allowedUrl = this.#assertAllowed(url);
    const { response, timeoutSignal } = await this.#request(allowedUrl, new Headers({ ...DEFAULT_HEADERS, accept }), signal);
    this.#assertSuccessful(response);
    return new TextDecoder().decode(await readBounded(response, this.#maxBytes, signal, timeoutSignal));
  }

  async #request(url: string, headers: Headers, signal?: AbortSignal): Promise<{
    response: Response;
    canonicalUrl: string;
    aliases: readonly string[];
    timeoutSignal: AbortSignal;
  }> {
    let current = url;
    const currentHeaders = new Headers(headers);
    const aliases: string[] = [];
    for (let redirectCount = 0; ; redirectCount += 1) {
      aliases.push(current);
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      // Keep DNS cancellation on a derived signal. Bun currently stops firing a
      // timeout signal after its last listener is removed; fetch/body streaming
      // must retain the original timeout for the rest of the request lifecycle.
      const resolutionSignal = AbortSignal.any(signal ? [signal, timeout] : [timeout]);
      let response: Response;
      try {
        await this.#assertPublicResolution(new URL(current).hostname, resolutionSignal);
        response = await this.#fetch(current, { headers: currentHeaders, redirect: "manual", signal: combinedSignal });
      } catch (error) {
        if (error instanceof SourceConnectorError) throw error;
        if (timeout.aborted) throw transient("FETCH_TIMEOUT", `Fetch timed out after ${this.#timeoutMs}ms.`, error);
        if (signal?.aborted) throw transient("FETCH_CANCELLED", "Fetch was cancelled.", error);
        throw transient("NETWORK_ERROR", error instanceof Error ? error.message : String(error), error);
      }
      if (!isRedirect(response.status)) {
        return { response, canonicalUrl: current, aliases: [...new Set(aliases)], timeoutSignal: timeout };
      }
      if (redirectCount >= this.#maxRedirects) throw deterministic("REDIRECT_LIMIT", "Redirect limit exceeded.");
      const location = response.headers.get("location");
      if (!location) throw deterministic("REDIRECT_LOCATION_MISSING", "Redirect response has no Location header.");
      const next = this.#assertAllowed(new URL(location, current).href);
      if (new URL(next).hostname.toLowerCase() !== new URL(current).hostname.toLowerCase()) {
        throw deterministic("CROSS_HOST_REDIRECT", "Redirects must remain on the original request host.");
      }
      current = next;
    }
  }

  #assertSuccessful(response: Response): void {
    if (response.ok) return;
    const code = `HTTP_${response.status}`;
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw transient(code, `Upstream returned HTTP ${response.status}.`);
    }
    throw deterministic(code, `Upstream returned HTTP ${response.status}.`);
  }

  #assertAllowed(value: string): string {
    const normalized = normalizeDocumentUrl(value);
    const url = new URL(normalized);
    if (!this.#allowedHosts.has(url.hostname.toLowerCase())) {
      throw deterministic("URL_HOST_NOT_ALLOWED", `URL host ${url.hostname} is not allowed.`);
    }
    if (!hasAllowedPrefix(url.pathname, this.#allowedPathPrefixes)) {
      throw deterministic("URL_PATH_NOT_ALLOWED", `URL path ${url.pathname} is not allowed.`);
    }
    return normalized;
  }

  async #assertPublicResolution(hostname: string, signal: AbortSignal): Promise<void> {
    let addresses: readonly string[];
    try { addresses = await settleBeforeAbort(() => this.#resolveHost(hostname), signal); } catch (error) {
      if (signal.aborted) throw error;
      throw transient("DNS_RESOLUTION_FAILED", `Could not resolve allowed host ${hostname}.`, error);
    }
    if (addresses.length === 0) throw transient("DNS_RESOLUTION_FAILED", `Allowed host ${hostname} resolved to no addresses.`);
    if (!this.#allowPrivateAddresses && addresses.some(isPrivateAddress)) {
      throw deterministic("URL_PRIVATE_ADDRESS_FORBIDDEN", `Allowed host ${hostname} resolved to a non-public address.`);
    }
  }
}

export function normalizeDocumentUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw deterministic("URL_SCHEME_NOT_ALLOWED", "URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw deterministic("URL_CREDENTIALS_FORBIDDEN", "URL must not contain credentials.");
  const secretParameter = [...url.searchParams.keys()].find((name) =>
    /^(?:token|access[_-]?token|api[_-]?key|signature|sig|credential|x-amz-.+)$/i.test(name));
  if (secretParameter) {
    throw deterministic("URL_SECRET_QUERY_FORBIDDEN", "URL must not contain secret-bearing query parameters.");
  }
  url.hash = "";
  const parameters = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, parameterValue] of parameters) url.searchParams.append(key, parameterValue);
  return url.toString();
}

function derivePathKey(url: URL, rule: NormalizedPathIdentityRule): LogicalDocumentKey {
  const decodedPath = safeDecode(url.pathname).replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/-+/g, "-");
  const humanPath = decodedPath === "/" ? "root" : decodedPath.replace(/\/$/, "");
  let key = `path:${humanPath}`;
  const retained = [...url.searchParams.entries()]
    .filter(([name]) => rule.queryParameters.includes(name))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  if (retained.length > 0) {
    const queryHash = createHash("sha256").update(JSON.stringify(retained)).digest("hex").slice(0, 16);
    key = `${key}:q-${queryHash}`;
  }
  if (key.length > 200) {
    const suffix = createHash("sha256").update(key).digest("hex").slice(0, 16);
    key = `${key.slice(0, 180).replace(/[^A-Za-z0-9]+$/, "")}:h-${suffix}`;
  }
  return createLogicalDocumentKey(key);
}

function canonicalizeForIdentity(url: URL, rule: NormalizedPathIdentityRule): string {
  const retained = [...url.searchParams.entries()]
    .filter(([name]) => rule.queryParameters.includes(name))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  const canonical = new URL(url);
  canonical.search = "";
  for (const [key, value] of retained) canonical.searchParams.append(key, value);
  return normalizeDocumentUrl(canonical.href);
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  timeoutSignal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw transient("FETCH_CANCELLED", "Fetch was cancelled.");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw deterministic("PAYLOAD_TOO_LARGE", `Response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceConnectorError) throw error;
    if (timeoutSignal?.aborted) throw transient("FETCH_TIMEOUT", "Fetch timed out while streaming the response body.", error);
    if (signal?.aborted) throw transient("FETCH_CANCELLED", "Fetch was cancelled.", error);
    throw transient("NETWORK_ERROR", error instanceof Error ? error.message : String(error), error);
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function extractSitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeXml(match[1]?.trim() ?? ""))
    .filter(Boolean);
}

function extractHtmlLinks(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => decodeXml(match[1] ?? match[2] ?? match[3] ?? ""))
    .filter(Boolean);
}

function decodeXml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}
function hasAllowedPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => prefix === "/"
    || pathname === prefix
    || (prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname.startsWith(`${prefix}/`)));
}
function isRedirect(status: number): boolean { return [301, 302, 303, 307, 308].includes(status); }
function safeDecode(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }
function sortedDocuments(documents: ReadonlyMap<string, DiscoveredSourceDocument>) { return [...documents.values()].sort((left, right) => left.url.localeCompare(right.url)); }
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive.`); return value; }
function nonNegativeInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative.`); return value; }
function transient(code: string, message: string, cause?: unknown): SourceConnectorError { return new SourceConnectorError(code, "transient", message, cause === undefined ? undefined : { cause }); }

function settleBeforeAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Request aborted.", "AbortError"));
  return new Promise((resolve, reject) => {
    const removeAbortListener = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      removeAbortListener();
      reject(new DOMException("Request aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(start).then(
      (value) => { removeAbortListener(); resolve(value); },
      (error: unknown) => { removeAbortListener(); reject(error); },
    );
  });
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (version === 6) {
    const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      return isPrivateAddress(mapped);
    }
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fe8")
      || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")
      || normalized.startsWith("fc") || normalized.startsWith("fd")
      || normalized.startsWith("ff") || normalized.startsWith("2001:db8:")
      || !/^[23][0-9a-f]{3}:/.test(normalized);
  }
  return true;
}

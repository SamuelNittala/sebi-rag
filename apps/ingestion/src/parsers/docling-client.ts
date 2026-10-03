import { createHash } from "node:crypto";

import {
  DOCLING_PARSE_MEDIA_TYPE,
  assertDoclingParseResponse,
  type DoclingParseResponse,
} from "./docling-contract.ts";

/**
 * HTTP client for the internal Docling service (`POST /v1/parse`).
 *
 * Error mapping: 422 -> deterministic with the service code; 400/413/415 ->
 * deterministic; 5xx, network failures and other statuses -> transient; caller
 * aborts and deadlines propagate unchanged. Error messages never echo service
 * bodies, which may contain paths or stack traces.
 */
export interface DoclingParseRequestOptions {
  readonly baseUrl: string;
  /** Must equal `producer.parserVersion`; a mismatch means the service changed under us. */
  readonly expectedParserVersion: string;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface DoclingHealth {
  readonly parserVersion: string;
}

const SERVICE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DETERMINISTIC_STATUS_CODES: Readonly<Record<number, string>> = {
  400: "DOCLING_CHECKSUM_REJECTED",
  413: "DOCLING_UPLOAD_TOO_LARGE",
  415: "DOCLING_UNSUPPORTED_MEDIA_TYPE",
};

export async function parseWithDocling(
  bytes: Uint8Array,
  options: DoclingParseRequestOptions,
): Promise<DoclingParseResponse> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await request(`${serviceBaseUrl(options.baseUrl)}/v1/parse`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-content-sha256": sha256,
      accept: DOCLING_PARSE_MEDIA_TYPE,
    },
    body: bytes,
    signal: options.signal,
  });

  if (response.status === 422) {
    const code = await serviceErrorCode(response, options);
    throw deterministic(code ?? "DOCLING_UNPROCESSABLE", "Docling service could not convert the document.");
  }
  const statusCode = DETERMINISTIC_STATUS_CODES[response.status];
  if (statusCode) {
    await response.body?.cancel();
    throw deterministic(statusCode, `Docling service rejected the request with HTTP ${response.status}.`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw transient(
      response.status >= 500 ? "DOCLING_SERVICE_ERROR" : "DOCLING_UNEXPECTED_STATUS",
      `Docling service responded with HTTP ${response.status}.`,
    );
  }

  const body = await readCapped(response, options.maxResponseBytes, options.signal);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw deterministic("INVALID_DOCLING_RESPONSE", "Docling parse response is not valid UTF-8 JSON.");
  }
  assertDoclingParseResponse(value);
  if (value.source.sha256 !== sha256 || value.source.byteSize !== bytes.byteLength) {
    throw deterministic("DOCLING_SOURCE_MISMATCH", "Docling parse response describes different source bytes.");
  }
  if (value.producer.parserVersion !== options.expectedParserVersion) {
    throw transient("DOCLING_VERSION_CHANGED", "Docling service parser version differs from the configured version.");
  }
  return value;
}

/** Reads `GET /health`; used by the stage worker to fail closed on a version mismatch. */
export async function fetchDoclingHealth(baseUrl: string, signal?: AbortSignal): Promise<DoclingHealth> {
  const response = await request(`${serviceBaseUrl(baseUrl)}/health`, { method: "GET", signal });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw transient("DOCLING_SERVICE_ERROR", `Docling health check responded with HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await readCapped(response, 64_000, signal)));
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if ((error as { code?: string }).code === "DOCLING_RESPONSE_TOO_LARGE") throw error;
    throw transient("DOCLING_SERVICE_ERROR", "Docling health response is not valid JSON.");
  }
  const parserVersion = (body as { parserVersion?: unknown } | null)?.parserVersion;
  if (typeof parserVersion !== "string" || !parserVersion) {
    throw transient("DOCLING_SERVICE_ERROR", "Docling health response has no parserVersion.");
  }
  return { parserVersion };
}

async function request(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  init.signal?.throwIfAborted();
  try {
    // Bun aborts fetch after 300 s by default; a large factsheet converts for longer,
    // so the caller's signal (PIPELINE_DOCLING_PARSE_DEADLINE_MS) is the only deadline.
    return await fetch(url, { ...init, redirect: "manual", timeout: false } as RequestInit);
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason;
    throw transient("DOCLING_SERVICE_UNAVAILABLE", "Docling service is unreachable.", error);
  }
}

async function serviceErrorCode(response: Response, options: DoclingParseRequestOptions): Promise<string | null> {
  try {
    const body = JSON.parse(new TextDecoder().decode(await readCapped(response, 64_000, options.signal))) as { code?: unknown };
    return typeof body?.code === "string" && SERVICE_CODE_PATTERN.test(body.code) ? body.code : null;
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    return null;
  }
}

async function readCapped(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge(maxBytes);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge(maxBytes);
      }
      parts.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if ((error as { code?: string }).code === "DOCLING_RESPONSE_TOO_LARGE") throw error;
    throw transient("DOCLING_SERVICE_UNAVAILABLE", "Docling response stream failed.", error);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function serviceBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function tooLarge(maxBytes: number): Error {
  return deterministic("DOCLING_RESPONSE_TOO_LARGE", `Docling response exceeds the ${maxBytes}-byte limit.`);
}

function deterministic(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}

function transient(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code,
    classification: "transient" as const,
  });
}

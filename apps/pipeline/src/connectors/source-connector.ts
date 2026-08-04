import type {
  LogicalDocumentKey,
  PipelineFailureClassification,
  SourceDiscoveryConfig,
  SourceFetchConstraints,
} from "@mf-rag/types";

export interface DiscoveredSourceDocument {
  readonly logicalDocumentKey: LogicalDocumentKey;
  readonly url: string;
}

export interface FetchValidators {
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

export interface FetchedSourceDocument {
  readonly kind: "fetched";
  readonly requestedUrl: string;
  readonly canonicalUrl: string;
  readonly aliases: readonly string[];
  readonly bytes: Uint8Array;
  readonly mediaType: "application/pdf";
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface NotModifiedSourceDocument {
  readonly kind: "not_modified";
  readonly requestedUrl: string;
  readonly canonicalUrl: string;
  readonly aliases: readonly string[];
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export type SourceFetchResult = FetchedSourceDocument | NotModifiedSourceDocument;

export interface SourceConnector {
  discover(config: SourceDiscoveryConfig, signal?: AbortSignal): Promise<readonly DiscoveredSourceDocument[]>;
  fetch(url: string, validators?: FetchValidators, signal?: AbortSignal): Promise<SourceFetchResult>;
}

export interface SourceConnectorOptions extends SourceFetchConstraints {
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  /** Test fixtures only. Production callers must use the fail-closed default. */
  readonly allowPrivateAddresses?: boolean;
}

/** A stable shape understood by the generic retry policy. */
export class SourceConnectorError extends Error {
  constructor(
    readonly code: string,
    readonly classification: PipelineFailureClassification,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SourceConnectorError";
  }
}

export function isPdfDocumentUrl(url: URL): boolean {
  return url.pathname.toLowerCase().endsWith(".pdf");
}

export function deterministicSourceConnectorError(code: string, message: string): SourceConnectorError {
  return new SourceConnectorError(code, "deterministic", message);
}

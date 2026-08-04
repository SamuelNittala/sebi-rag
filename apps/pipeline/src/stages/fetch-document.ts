import { sha256Hex, persistVerifiedArtifact, type ArtifactStore } from "../artifacts/artifact-store.ts";
import { SourceConnectorError, type DiscoveredSourceDocument, type SourceConnector } from "../connectors/source-connector.ts";

export interface SourceDocumentState {
  readonly sourceDocumentId: string;
  readonly canonicalUrl: string;
  readonly currentVersionId: string | null;
  readonly currentSha256: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface SuccessfulDocumentObservation {
  readonly sourceDocumentId: string;
  readonly observedUrl: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface DocumentAcquisitionRepository {
  findDocumentState(input: {
    readonly accessScopeId: string;
    readonly sourceId: string;
    readonly logicalDocumentKey: string;
  }): Promise<SourceDocumentState | null>;
  findOrCreateDocument(input: {
    readonly fence: DiscoveryMutationFence;
    readonly accessScopeId: string;
    readonly sourceId: string;
    readonly logicalDocumentKey: string;
    readonly canonicalUrl: string;
  }): Promise<SourceDocumentState>;
  recordAlias(input: {
    readonly fence: DiscoveryMutationFence;
    readonly accessScopeId: string;
    readonly sourceId: string;
    readonly sourceDocumentId: string;
    readonly aliasUrl: string;
  }): Promise<void>;
  recordVersionAndEnsureParse(input: {
    readonly fence: DiscoveryMutationFence;
    readonly sourceDocumentId: string;
    readonly artifact: Awaited<ReturnType<ArtifactStore["put"]>>;
    readonly etag: string | null;
    readonly lastModified: string | null;
    readonly pipelineIdentity: DocumentPipelineIdentity;
  }): Promise<{ readonly documentVersionId: string; readonly created: boolean }>;
  ensureParse(input: {
    readonly fence: DiscoveryMutationFence;
    readonly documentVersionId: string;
    readonly inputChecksum: string;
    readonly pipelineIdentity: DocumentPipelineIdentity;
  }): Promise<void>;
}

export interface DiscoveryMutationFence {
  readonly discoveryRunId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
}

export interface DocumentPipelineIdentity {
  readonly pipelineImplementationVersion: string;
  readonly parseImplementationVersion: string;
  readonly maxAttempts: number;
}

export interface FetchDocumentResult {
  readonly changed: boolean;
  readonly observation: SuccessfulDocumentObservation;
}

export class FetchDocumentStage {
  constructor(private readonly options: {
    readonly repository: DocumentAcquisitionRepository;
    readonly artifactStore: ArtifactStore;
    readonly pipelineIdentity: DocumentPipelineIdentity;
    readonly artifactProducerVersion: string;
  }) {
    assertNonEmpty(options.pipelineIdentity.pipelineImplementationVersion, "Pipeline implementation version");
    assertNonEmpty(options.pipelineIdentity.parseImplementationVersion, "Parse implementation version");
    if (!Number.isSafeInteger(options.pipelineIdentity.maxAttempts) || options.pipelineIdentity.maxAttempts <= 0) {
      throw new Error("Parse maximum attempts must be positive.");
    }
    assertNonEmpty(options.artifactProducerVersion, "Artifact producer version");
  }

  async execute(input: {
    readonly connector: SourceConnector;
    readonly accessScopeId: string;
    readonly sourceId: string;
    readonly fence: DiscoveryMutationFence;
    readonly document: DiscoveredSourceDocument;
    readonly signal?: AbortSignal;
  }): Promise<FetchDocumentResult> {
    const repository = this.options.repository;
    const existing = await repository.findDocumentState({
      accessScopeId: input.accessScopeId,
      sourceId: input.sourceId,
      logicalDocumentKey: String(input.document.logicalDocumentKey),
    });
    const requestedUrlMatchesCanonical = existing?.canonicalUrl === input.document.url;
    const fetched = await input.connector.fetch(input.document.url, {
      etag: requestedUrlMatchesCanonical ? existing?.etag : null,
      lastModified: requestedUrlMatchesCanonical ? existing?.lastModified : null,
    }, input.signal);

    if (fetched.kind === "not_modified" && !existing) {
      throw new SourceConnectorError(
        "UNEXPECTED_NOT_MODIFIED",
        "deterministic",
        "Upstream returned 304 for a logical document with no persisted version.",
      );
    }
    const sourceDocument = existing ?? await repository.findOrCreateDocument({
      fence: input.fence,
      accessScopeId: input.accessScopeId,
      sourceId: input.sourceId,
      logicalDocumentKey: String(input.document.logicalDocumentKey),
      canonicalUrl: input.document.url,
    });
    for (const aliasUrl of fetched.aliases) {
      await repository.recordAlias({
        fence: input.fence,
        accessScopeId: input.accessScopeId,
        sourceId: input.sourceId,
        sourceDocumentId: sourceDocument.sourceDocumentId,
        aliasUrl,
      });
    }

    const observation: SuccessfulDocumentObservation = {
      sourceDocumentId: sourceDocument.sourceDocumentId,
      observedUrl: fetched.canonicalUrl,
      etag: fetched.etag ?? existing?.etag ?? null,
      lastModified: fetched.lastModified ?? existing?.lastModified ?? null,
    };
    if (fetched.kind === "not_modified") {
      await this.#ensureExistingParse(existing, input.fence);
      return { changed: false, observation };
    }

    const checksum = sha256Hex(fetched.bytes);
    if (checksum === existing?.currentSha256) {
      await this.#ensureExistingParse(existing, input.fence);
      return { changed: false, observation };
    }

    const version = await persistVerifiedArtifact(this.options.artifactStore, {
      namespace: `raw/${input.accessScopeId}/${input.sourceId}/${sourceDocument.sourceDocumentId}`,
      bytes: fetched.bytes,
      sha256: checksum,
      byteSize: fetched.bytes.byteLength,
      mediaType: fetched.mediaType,
      producerVersion: this.options.artifactProducerVersion,
    }, (artifact) => repository.recordVersionAndEnsureParse({
      fence: input.fence,
      sourceDocumentId: sourceDocument.sourceDocumentId,
      artifact,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      pipelineIdentity: this.options.pipelineIdentity,
    }));
    return { changed: version.created, observation };
  }

  async #ensureExistingParse(state: SourceDocumentState | null, fence: DiscoveryMutationFence): Promise<void> {
    if (!state?.currentVersionId || !state.currentSha256) {
      throw new SourceConnectorError("MISSING_CURRENT_VERSION", "deterministic", "Unchanged response has no current immutable version.");
    }
    await this.options.repository.ensureParse({
      fence,
      documentVersionId: state.currentVersionId,
      inputChecksum: state.currentSha256,
      pipelineIdentity: this.options.pipelineIdentity,
    });
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

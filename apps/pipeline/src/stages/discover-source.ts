import type { Database } from "@mf-rag/db";
import {
  ensureDocumentVersionPipelineForDiscovery,
  findOrCreateSourceDocumentForDiscovery,
  findSourceDocumentFetchState,
  loadDiscoveryExecutionConfig,
  recordFetchedDocumentVersionAndEnsurePipeline,
  recordSourceDocumentAlias,
  recordSuccessfulDocumentObservations,
} from "@mf-rag/db";
import type { SourceDiscoveryConfig, SourceFetchConstraints } from "@mf-rag/types";

import type { SourceConnector } from "../connectors/source-connector.ts";
import {
  FetchDocumentStage,
  type DocumentAcquisitionRepository,
  type DiscoveryMutationFence,
  type SuccessfulDocumentObservation,
} from "./fetch-document.ts";

export interface DiscoverySourceRepository extends DocumentAcquisitionRepository {
  loadExecutionConfig(input: DiscoveryMutationFence & {
    readonly sourceId: string;
    readonly configRevisionId: string;
  }): Promise<{
    readonly accessScopeId: string;
    readonly discovery: SourceDiscoveryConfig;
    readonly fetch: SourceFetchConstraints;
  }>;
  recordSuccessfulObservations(
    fence: DiscoveryMutationFence,
    observations: readonly SuccessfulDocumentObservation[],
  ): Promise<void>;
}

export class DiscoverSourceStage {
  constructor(private readonly options: {
    readonly repository: DiscoverySourceRepository;
    readonly connectorFactory: (fetch: SourceFetchConstraints) => SourceConnector;
    readonly fetchStage: FetchDocumentStage;
  }) {}

  async execute(input: {
    readonly discoveryRunId: string;
    readonly sourceId: string;
    readonly configRevisionId: string;
    readonly owner: string;
    readonly leaseEpoch: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly discovered: number; readonly changed: number; readonly unchanged: number }> {
    const fence = { discoveryRunId: input.discoveryRunId, owner: input.owner, leaseEpoch: input.leaseEpoch };
    const config = await this.options.repository.loadExecutionConfig({
      ...fence, sourceId: input.sourceId, configRevisionId: input.configRevisionId,
    });
    const connector = this.options.connectorFactory(config.fetch);
    const discovered = await connector.discover(config.discovery, input.signal);
    const observations: SuccessfulDocumentObservation[] = [];
    let changed = 0;
    for (const document of discovered) {
      const result = await this.options.fetchStage.execute({
        connector,
        accessScopeId: config.accessScopeId,
        sourceId: input.sourceId,
        fence,
        document,
        signal: input.signal,
      });
      observations.push(result.observation);
      if (result.changed) changed += 1;
    }
    // This single fenced call is deliberately last and atomically marks the
    // run successful: partial/failed discovery never updates presence or
    // future missing-document counters.
    await this.options.repository.recordSuccessfulObservations(fence, observations);
    return { discovered: discovered.length, changed, unchanged: discovered.length - changed };
  }
}

export function createDatabaseDiscoverySourceRepository(db: Database): DiscoverySourceRepository {
  return {
    loadExecutionConfig: (input) => loadDiscoveryExecutionConfig(db, input),
    findDocumentState: (input) => findSourceDocumentFetchState(db, input),
    async findOrCreateDocument(input) {
      const document = await findOrCreateSourceDocumentForDiscovery(db, input);
      return {
        sourceDocumentId: document.id,
        canonicalUrl: document.canonicalUrl,
        currentVersionId: document.currentVersionId,
        currentSha256: null,
        etag: null,
        lastModified: null,
      };
    },
    async recordAlias(input) { await recordSourceDocumentAlias(db, input); },
    async recordVersionAndEnsureParse(input) {
      const result = await recordFetchedDocumentVersionAndEnsurePipeline(db, input);
      return { documentVersionId: result.version.id, created: result.created };
    },
    async ensureParse(input) {
      await ensureDocumentVersionPipelineForDiscovery(db, input);
    },
    async recordSuccessfulObservations(fence, observations) {
      await recordSuccessfulDocumentObservations(db, { ...fence, observations });
    },
  };
}

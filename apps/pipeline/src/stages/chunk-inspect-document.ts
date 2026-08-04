import {
  accessScopes,
  and,
  documentVersions,
  eq,
  pipelineRuns,
  sourceDocuments,
  sourceRegistryRevisions,
  sources,
  stageAttempts,
  type Database,
} from "@mf-rag/db";
import type { ArtifactDescriptor, KnowledgeScope } from "@mf-rag/types";

import type {
  StageHandlerContext,
  StageHandlerResult,
  StageImplementationIdentityInput,
  StageRegistrationInput,
} from "../runtime/stage-registry.ts";
import { decodeArtifactOutputRef } from "./parse-document.ts";

interface TrustedContext {
  readonly accessScopeId: string;
  readonly accessScopeKey: string;
  readonly externalCode: string;
  readonly configRevisionId: string;
  readonly configRevisionChecksum: string;
  readonly classification: KnowledgeScope;
}

export interface ChunkInspectDocumentAdapter {
  execute(input: {
    readonly documentVersionId: string;
    readonly pipelineRunId: string;
    readonly sourceDocumentId: string;
    readonly accessScopeId: string;
    readonly parsedArtifact: ArtifactDescriptor;
    readonly expectedParsedChecksum: string;
    readonly trustedContext: TrustedContext;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly reviewRunId: string; readonly outputChecksum: string }>;
}

export interface ChunkInspectDocumentRepository {
  loadInput(context: StageHandlerContext): Promise<{
    readonly sourceDocumentId: string;
    readonly parsedArtifact: ArtifactDescriptor;
    readonly trustedContext: TrustedContext;
  }>;
}

export class ChunkInspectDocumentStage {
  constructor(private readonly options: {
    readonly repository: ChunkInspectDocumentRepository;
    readonly adapter: ChunkInspectDocumentAdapter;
  }) {}

  async execute(context: StageHandlerContext): Promise<StageHandlerResult> {
    const input = await this.options.repository.loadInput(context);
    const result = await this.options.adapter.execute({
      documentVersionId: context.documentVersionId,
      pipelineRunId: context.pipelineRunId,
      sourceDocumentId: input.sourceDocumentId,
      accessScopeId: context.accessScopeId,
      parsedArtifact: input.parsedArtifact,
      expectedParsedChecksum: context.inputChecksum,
      trustedContext: input.trustedContext,
      signal: context.signal,
    });
    return { outputRef: `review:${result.reviewRunId}`, outputChecksum: result.outputChecksum };
  }
}

export function createDatabaseChunkInspectDocumentRepository(db: Database): ChunkInspectDocumentRepository {
  return {
    async loadInput(context) {
      const [lineage] = await db.select({
        run: pipelineRuns,
        version: documentVersions,
        document: sourceDocuments,
        source: sources,
        scope: accessScopes,
        revision: sourceRegistryRevisions,
      }).from(pipelineRuns)
        .innerJoin(documentVersions, eq(documentVersions.id, pipelineRuns.documentVersionId))
        .innerJoin(sourceDocuments, eq(sourceDocuments.id, documentVersions.sourceDocumentId))
        .innerJoin(sources, eq(sources.id, pipelineRuns.sourceId))
        .innerJoin(accessScopes, eq(accessScopes.id, pipelineRuns.accessScopeId))
        .innerJoin(sourceRegistryRevisions, eq(sourceRegistryRevisions.id, pipelineRuns.configRevisionId))
        .where(and(
          eq(pipelineRuns.id, context.pipelineRunId),
          eq(pipelineRuns.documentVersionId, context.documentVersionId),
          eq(pipelineRuns.accessScopeId, context.accessScopeId),
          eq(pipelineRuns.sourceId, context.sourceId),
        )).limit(1);
      if (!lineage?.run.configRevisionId) {
        throw deterministicError("MISSING_IMMUTABLE_CONFIG", "Chunk stage has no immutable registry lineage.");
      }
      const desiredScope = lineage.revision.desiredState.accessScopes.find((scope) =>
        String(scope.accessScopeKey) === lineage.scope.accessScopeKey);
      const desiredSource = desiredScope?.sources.find((source) =>
        String(source.sourceKey) === lineage.source.sourceKey);
      if (!desiredScope || !desiredSource) {
        throw deterministicError("IMMUTABLE_CONFIG_MISMATCH", "Pipeline source is absent from its immutable registry snapshot.");
      }
      const [parseSuccess] = await db.select({ outputRef: stageAttempts.outputRef }).from(stageAttempts)
        .where(and(
          eq(stageAttempts.documentVersionId, context.documentVersionId),
          eq(stageAttempts.stage, "PARSE"),
          eq(stageAttempts.status, "succeeded"),
          eq(stageAttempts.outputChecksum, context.inputChecksum),
        )).limit(1);
      if (!parseSuccess?.outputRef) {
        throw deterministicError("PARSED_OUTPUT_NOT_FOUND", "No compatible successful PARSE artifact exists for this input.");
      }
      return {
        sourceDocumentId: lineage.document.id,
        parsedArtifact: decodeArtifactOutputRef(parseSuccess.outputRef),
        trustedContext: {
          accessScopeId: lineage.scope.id,
          accessScopeKey: String(desiredScope.accessScopeKey),
          externalCode: String(desiredScope.externalCode),
          configRevisionId: lineage.revision.id,
          configRevisionChecksum: lineage.revision.checksum,
          classification: desiredScope.classification,
        },
      };
    },
  };
}

/** Fixed-order registrations for the two independently deployable U6 workers. */
export function createParseChunkStageRegistrations(input: {
  readonly parse: ParseLike;
  readonly parseIdentity: StageImplementationIdentityInput;
  readonly chunkInspect: ChunkLike;
  readonly chunkInspectIdentity: StageImplementationIdentityInput;
}): readonly StageRegistrationInput[] {
  return [
    { stage: "PARSE", implementationIdentity: input.parseIdentity, handler: (context) => input.parse.execute(context) },
    { stage: "CHUNK_AND_INSPECT", implementationIdentity: input.chunkInspectIdentity, handler: (context) => input.chunkInspect.execute(context) },
  ];
}

interface ParseLike {
  execute(context: StageHandlerContext): Promise<StageHandlerResult>;
}

interface ChunkLike {
  execute(context: StageHandlerContext): Promise<StageHandlerResult>;
}

function deterministicError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}

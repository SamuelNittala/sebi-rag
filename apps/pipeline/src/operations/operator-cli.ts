import {
  accessScopes,
  db,
  documentPublicationGenerations,
  eq,
  ingestionRuns,
  pauseSourceSchedule,
  reactivateScheduledPublicationGeneration,
  requeueDeadLetterAttempt,
  requeueDeadLetterDiscoveryRun,
  resumeSourceSchedule,
  setAccessScopeEmergencyFreeze,
  setSourceEmergencyFreeze,
  sourceSchedules,
  sources,
  sql,
  stageAttempts,
  type Database,
} from "@mf-rag/db";

export interface PipelineOperatorStatus {
  readonly sources: readonly {
    readonly sourceId: string;
    readonly sourceKey: string;
    readonly accessScopeId: string;
    readonly externalCode: string;
    readonly scheduleEnabled: boolean;
    readonly paused: boolean;
    readonly emergencyFrozen: boolean;
    readonly nextDueAt: string;
  }[];
  readonly queue: {
    readonly pending: number;
    readonly running: number;
    readonly retries: number;
    readonly deadLetters: number;
    readonly waitingReview: number;
    readonly publicationLag: number;
  };
}

export interface PipelineOperatorRepository {
  status(): Promise<PipelineOperatorStatus>;
  pauseSource(sourceId: string): Promise<boolean>;
  resumeSource(sourceId: string): Promise<boolean>;
  freezeSource(sourceId: string, reason: string | null): Promise<boolean>;
  freezeAccessScope(accessScopeId: string, reason: string | null): Promise<boolean>;
  requeueStage(input: {
    readonly attemptId: string;
    readonly operator: string;
    readonly expectedInputChecksum: string;
    readonly expectedAccessScopeId: string;
    readonly expectedSourceId: string;
    readonly expectedDocumentVersionId: string;
  }): Promise<{ readonly id: string }>;
  requeueDiscovery(input: {
    readonly discoveryRunId: string;
    readonly operator: string;
    readonly expectedSourceId: string;
    readonly expectedConfigRevisionId: string;
  }): Promise<{ readonly id: string }>;
  reactivateGeneration(input: {
    readonly sourceDocumentId: string;
    readonly currentGenerationId: string;
    readonly targetGenerationId: string;
    readonly expectedAccessScopeId: string;
    readonly expectedSourceId: string;
    readonly actor: string;
    readonly incidentId: string;
  }): Promise<{ readonly generationId: string; readonly replacedGenerationId: string }>;
}

export function createDatabasePipelineOperatorRepository(database: Database): PipelineOperatorRepository {
  return {
    status: () => loadStatus(database),
    pauseSource: (sourceId) => pauseSourceSchedule(database, sourceId),
    resumeSource: (sourceId) => resumeSourceSchedule(database, sourceId),
    freezeSource: (sourceId, reason) => setSourceEmergencyFreeze(database, { sourceId, reason }),
    freezeAccessScope: (accessScopeId, reason) => setAccessScopeEmergencyFreeze(database, { accessScopeId, reason }),
    requeueStage: (input) => requeueDeadLetterAttempt(database, input),
    requeueDiscovery: (input) => requeueDeadLetterDiscoveryRun(database, input),
    reactivateGeneration: (input) => reactivateScheduledPublicationGeneration(database, input),
  };
}

export async function runOperatorCli(
  args: readonly string[],
  repository: PipelineOperatorRepository,
  write: (value: string) => void = console.log,
): Promise<void> {
  const [command, ...tokens] = args;
  const flags = parseFlags(tokens);
  switch (command) {
    case "status":
      write(JSON.stringify(await repository.status(), null, 2));
      return;
    case "pause-source":
      await requireChanged(repository.pauseSource(requiredFlag(flags, "source-id")), command);
      return;
    case "resume-source":
      await requireChanged(repository.resumeSource(requiredFlag(flags, "source-id")), command);
      return;
    case "freeze-source":
      await requireChanged(repository.freezeSource(
        requiredFlag(flags, "source-id"), requiredFlag(flags, "reason"),
      ), command);
      return;
    case "unfreeze-source":
      await requireChanged(repository.freezeSource(requiredFlag(flags, "source-id"), null), command);
      return;
    case "freeze-scope":
      await requireChanged(repository.freezeAccessScope(
        requiredFlag(flags, "access-scope-id"), requiredFlag(flags, "reason"),
      ), command);
      return;
    case "unfreeze-scope":
      await requireChanged(repository.freezeAccessScope(requiredFlag(flags, "access-scope-id"), null), command);
      return;
    case "requeue-stage": {
      const result = await repository.requeueStage({
        attemptId: requiredFlag(flags, "attempt-id"),
        operator: requiredFlag(flags, "operator"),
        expectedInputChecksum: sha256Flag(flags, "expected-input-checksum"),
        expectedAccessScopeId: requiredFlag(flags, "expected-access-scope-id"),
        expectedSourceId: requiredFlag(flags, "expected-source-id"),
        expectedDocumentVersionId: requiredFlag(flags, "expected-document-version-id"),
      });
      write(JSON.stringify({ requeuedAttemptId: result.id }));
      return;
    }
    case "requeue-discovery": {
      const result = await repository.requeueDiscovery({
        discoveryRunId: requiredFlag(flags, "discovery-run-id"),
        operator: requiredFlag(flags, "operator"),
        expectedSourceId: requiredFlag(flags, "expected-source-id"),
        expectedConfigRevisionId: requiredFlag(flags, "expected-config-revision-id"),
      });
      write(JSON.stringify({ requeuedDiscoveryRunId: result.id }));
      return;
    }
    case "reactivate-generation": {
      const result = await repository.reactivateGeneration({
        sourceDocumentId: requiredFlag(flags, "source-document-id"),
        currentGenerationId: requiredFlag(flags, "current-generation-id"),
        targetGenerationId: requiredFlag(flags, "target-generation-id"),
        expectedAccessScopeId: requiredFlag(flags, "expected-access-scope-id"),
        expectedSourceId: requiredFlag(flags, "expected-source-id"),
        actor: requiredFlag(flags, "operator"),
        incidentId: requiredFlag(flags, "incident-id"),
      });
      write(JSON.stringify(result));
      return;
    }
    default:
      throw new Error("Usage: pipeline-operator <status|pause-source|resume-source|freeze-source|unfreeze-source|freeze-scope|unfreeze-scope|requeue-stage|requeue-discovery|reactivate-generation> [--flag value]");
  }
}

async function loadStatus(database: Database): Promise<PipelineOperatorStatus> {
  const [rows, queueRows, reviewRows, publicationRows] = await Promise.all([
    database.select({
      sourceId: sources.id,
      sourceKey: sources.sourceKey,
      accessScopeId: accessScopes.id,
      externalCode: accessScopes.externalCode,
      scheduleEnabled: sourceSchedules.enabled,
      pausedAt: sourceSchedules.pausedAt,
      sourceFrozenAt: sources.emergencyFrozenAt,
      scopeFrozenAt: accessScopes.emergencyFrozenAt,
      nextDueAt: sourceSchedules.nextDueAt,
    }).from(sources)
      .innerJoin(accessScopes, eq(accessScopes.id, sources.accessScopeId))
      .innerJoin(sourceSchedules, eq(sourceSchedules.sourceId, sources.id)),
    database.select({
      pending: sql<number>`count(*) filter (where ${stageAttempts.status} = 'pending')::int`,
      running: sql<number>`count(*) filter (where ${stageAttempts.status} = 'running')::int`,
      retries: sql<number>`count(*) filter (where ${stageAttempts.status} = 'retry_wait')::int`,
      deadLetters: sql<number>`count(*) filter (where ${stageAttempts.status} = 'dead_letter' and ${stageAttempts.isCurrent} = true)::int`,
    }).from(stageAttempts),
    database.select({
      waitingReview: sql<number>`count(*) filter (where ${ingestionRuns.status} = 'review_ready')::int`,
    }).from(ingestionRuns),
    database.select({
      publicationLag: sql<number>`count(*) filter (where ${documentPublicationGenerations.status} = 'staged')::int`,
    }).from(documentPublicationGenerations),
  ]);
  const queue = queueRows[0];
  const review = reviewRows[0];
  const publication = publicationRows[0];
  return {
    sources: rows.map((row) => ({
      sourceId: row.sourceId,
      sourceKey: row.sourceKey,
      accessScopeId: row.accessScopeId,
      externalCode: row.externalCode,
      scheduleEnabled: row.scheduleEnabled,
      paused: Boolean(row.pausedAt),
      emergencyFrozen: Boolean(row.sourceFrozenAt || row.scopeFrozenAt),
      nextDueAt: row.nextDueAt.toISOString(),
    })),
    queue: {
      pending: queue?.pending ?? 0,
      running: queue?.running ?? 0,
      retries: queue?.retries ?? 0,
      deadLetters: queue?.deadLetters ?? 0,
      waitingReview: review?.waitingReview ?? 0,
      publicationLag: publication?.publicationLag ?? 0,
    },
  };
}

function parseFlags(tokens: readonly string[]): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid operator flag near ${name ?? "end of command"}.`);
    if (flags.has(name.slice(2))) throw new Error(`Duplicate operator flag: ${name}.`);
    flags.set(name.slice(2), value);
  }
  return flags;
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function sha256Flag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = requiredFlag(flags, name);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`--${name} must be a lowercase SHA-256 checksum.`);
  return value;
}

async function requireChanged(result: Promise<boolean>, command: string): Promise<void> {
  if (!await result) throw new Error(`${command} did not match an eligible control-plane row.`);
}

if (import.meta.main) {
  await runOperatorCli(process.argv.slice(2), createDatabasePipelineOperatorRepository(db));
}

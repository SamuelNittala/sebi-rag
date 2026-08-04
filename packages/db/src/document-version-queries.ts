import { and, desc, eq, sql } from "drizzle-orm";
import { createLogicalDocumentKey, type ArtifactDescriptor } from "@mf-rag/types";

import type { Database } from "./client.ts";
import {
  artifacts,
  discoveryRuns,
  documentObservations,
  documentVersions,
  documents,
  htmlDocuments,
  sourceDocuments,
  sourceDocumentUrlAliases,
  sources,
  pipelineRuns,
  stageAttempts,
} from "./schema.ts";

export interface FindOrCreateSourceDocumentInput {
  readonly accessScopeId: string;
  readonly sourceId: string;
  readonly logicalDocumentKey: string;
  readonly canonicalUrl: string;
}

export interface RecordFetchedDocumentVersionInput {
  readonly sourceDocumentId: string;
  readonly artifact: ArtifactDescriptor;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly observedAt?: Date;
}

export interface RecordFetchedDocumentVersionResult {
  readonly version: typeof documentVersions.$inferSelect;
  readonly created: boolean;
}

export interface CompareAndSetCurrentDocumentVersionInput {
  readonly sourceDocumentId: string;
  readonly expectedCurrentVersionId: string | null;
  readonly proposedVersionId: string;
}

export interface RecordDocumentObservationInput {
  readonly discoveryRunId: string;
  readonly sourceDocumentId: string;
  readonly observedUrl: string;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly observedAt?: Date;
}

export interface FindSourceDocumentFetchStateInput {
  readonly accessScopeId: string;
  readonly sourceId: string;
  readonly logicalDocumentKey: string;
}

export interface RecordSourceDocumentAliasInput {
  readonly fence: DiscoveryWriteFence;
  readonly accessScopeId: string;
  readonly sourceId: string;
  readonly sourceDocumentId: string;
  readonly aliasUrl: string;
}

export interface RecordSuccessfulDocumentObservationsInput {
  readonly discoveryRunId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
  readonly observations: readonly Omit<RecordDocumentObservationInput, "discoveryRunId">[];
}

export interface DiscoveryWriteFence {
  readonly discoveryRunId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
}

export interface PipelineIdentityInput {
  readonly pipelineImplementationVersion: string;
  readonly parseImplementationVersion: string;
  readonly maxAttempts: number;
}

export interface RecordFetchedDocumentVersionAndEnsurePipelineInput {
  readonly fence: DiscoveryWriteFence;
  readonly sourceDocumentId: string;
  readonly artifact: ArtifactDescriptor;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly pipelineIdentity: PipelineIdentityInput;
  readonly observedAt?: Date;
}

export interface EnsureDocumentVersionPipelineForDiscoveryInput {
  readonly fence: DiscoveryWriteFence;
  readonly documentVersionId: string;
  readonly inputChecksum: string;
  readonly pipelineIdentity: PipelineIdentityInput;
}

export type LegacyDocumentVersionIssueKind =
  | "UNRESOLVED_OWNERSHIP"
  | "AMBIGUOUS_CANONICAL_URL"
  | "GLOBAL_CONTENT_COLLISION";

export interface LegacyDocumentVersionIssue {
  readonly kind: LegacyDocumentVersionIssueKind;
  readonly value: string;
  readonly legacyDocumentIds: readonly string[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export async function findSourceDocumentFetchState(
  db: Database,
  input: FindSourceDocumentFetchStateInput,
): Promise<{
  readonly sourceDocumentId: string;
  readonly canonicalUrl: string;
  readonly currentVersionId: string | null;
  readonly currentSha256: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
} | null> {
  const logicalDocumentKey = createLogicalDocumentKey(input.logicalDocumentKey);
  const [row] = await db.select({
    sourceDocumentId: sourceDocuments.id,
    canonicalUrl: sourceDocuments.canonicalUrl,
    currentVersionId: sourceDocuments.currentVersionId,
    currentSha256: documentVersions.contentSha256,
    etag: documentVersions.etag,
    lastModified: documentVersions.lastModified,
  }).from(sourceDocuments)
    .leftJoin(documentVersions, eq(documentVersions.id, sourceDocuments.currentVersionId))
    .where(and(
      eq(sourceDocuments.accessScopeId, input.accessScopeId),
      eq(sourceDocuments.sourceId, input.sourceId),
      eq(sourceDocuments.logicalDocumentKey, logicalDocumentKey),
    )).limit(1);
  return row ?? null;
}

/**
 * Resolve a stable source-owned document identity. Canonical URL ownership is
 * access-scoped, so two sources in one scope cannot silently publish duplicates.
 */
export async function findOrCreateSourceDocument(
  db: Database,
  input: FindOrCreateSourceDocumentInput,
): Promise<typeof sourceDocuments.$inferSelect> {
  const logicalDocumentKey = createLogicalDocumentKey(input.logicalDocumentKey);
  const canonicalUrl = canonicalHttpUrl(input.canonicalUrl);

  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(sources)
      .where(eq(sources.id, input.sourceId)).limit(1);
    if (!source || source.accessScopeId !== input.accessScopeId) {
      throw new Error("Source document ownership does not match the source access scope.");
    }

    const [urlOwner] = await tx.select().from(sourceDocuments).where(and(
      eq(sourceDocuments.accessScopeId, input.accessScopeId),
      eq(sourceDocuments.canonicalUrl, canonicalUrl),
    )).limit(1);
    if (urlOwner && (
      urlOwner.sourceId !== input.sourceId
      || urlOwner.logicalDocumentKey !== logicalDocumentKey
    )) {
      throw new Error("The canonical URL is already owned by another logical document in this access scope.");
    }

    const [inserted] = await tx.insert(sourceDocuments).values({
      accessScopeId: input.accessScopeId,
      sourceId: input.sourceId,
      logicalDocumentKey,
      canonicalUrl,
    }).onConflictDoNothing({
      target: [sourceDocuments.sourceId, sourceDocuments.logicalDocumentKey],
    }).returning();

    const document = inserted ?? (await tx.select().from(sourceDocuments).where(and(
      eq(sourceDocuments.sourceId, input.sourceId),
      eq(sourceDocuments.logicalDocumentKey, logicalDocumentKey),
    )).limit(1))[0];
    if (!document) throw new Error("Failed to resolve logical source document.");
    if (document.accessScopeId !== input.accessScopeId || document.canonicalUrl !== canonicalUrl) {
      throw new Error("Logical document identity conflicts with existing ownership or canonical URL.");
    }

    await tx.insert(sourceDocumentUrlAliases).values({
      sourceDocumentId: document.id,
      accessScopeId: document.accessScopeId,
      sourceId: document.sourceId,
      aliasUrl: canonicalUrl,
      isCanonical: true,
    }).onConflictDoNothing({
      target: [sourceDocumentUrlAliases.accessScopeId, sourceDocumentUrlAliases.aliasUrl],
    });

    return document;
  });
}

/** Discovery writer variant: identity creation is rejected after lease reassignment. */
export async function findOrCreateSourceDocumentForDiscovery(
  db: Database,
  input: FindOrCreateSourceDocumentInput & { readonly fence: DiscoveryWriteFence },
): Promise<typeof sourceDocuments.$inferSelect> {
  const logicalDocumentKey = createLogicalDocumentKey(input.logicalDocumentKey);
  const canonicalUrl = canonicalHttpUrl(input.canonicalUrl);
  return db.transaction(async (tx) => {
    const fence = await assertDiscoveryWriteFence(tx, input.fence);
    if (fence.sourceId !== input.sourceId) throw new Error("Discovery write fence belongs to another source.");
    const [source] = await tx.select().from(sources).where(eq(sources.id, input.sourceId)).limit(1);
    if (!source || source.accessScopeId !== input.accessScopeId) {
      throw new Error("Source document ownership does not match the source access scope.");
    }
    const [urlOwner] = await tx.select().from(sourceDocuments).where(and(
      eq(sourceDocuments.accessScopeId, input.accessScopeId),
      eq(sourceDocuments.canonicalUrl, canonicalUrl),
    )).limit(1);
    if (urlOwner && (urlOwner.sourceId !== input.sourceId || urlOwner.logicalDocumentKey !== logicalDocumentKey)) {
      throw new Error("The canonical URL is already owned by another logical document in this access scope.");
    }
    const [inserted] = await tx.insert(sourceDocuments).values({
      accessScopeId: input.accessScopeId, sourceId: input.sourceId,
      logicalDocumentKey, canonicalUrl,
    }).onConflictDoNothing({ target: [sourceDocuments.sourceId, sourceDocuments.logicalDocumentKey] }).returning();
    const document = inserted ?? (await tx.select().from(sourceDocuments).where(and(
      eq(sourceDocuments.sourceId, input.sourceId),
      eq(sourceDocuments.logicalDocumentKey, logicalDocumentKey),
    )).limit(1))[0];
    if (!document || document.accessScopeId !== input.accessScopeId || document.canonicalUrl !== canonicalUrl) {
      throw new Error("Logical document identity conflicts with existing ownership or canonical URL.");
    }
    await tx.insert(sourceDocumentUrlAliases).values({
      sourceDocumentId: document.id, accessScopeId: document.accessScopeId,
      sourceId: document.sourceId, aliasUrl: canonicalUrl, isCanonical: true,
    }).onConflictDoNothing({ target: [sourceDocumentUrlAliases.accessScopeId, sourceDocumentUrlAliases.aliasUrl] });
    return document;
  });
}

/** Add a redirect/request alias while enforcing one URL owner per access scope. */
export async function recordSourceDocumentAlias(
  db: Database,
  input: RecordSourceDocumentAliasInput,
): Promise<void> {
  const aliasUrl = canonicalHttpUrl(input.aliasUrl);
  await db.transaction(async (tx) => {
    const fence = await assertDiscoveryWriteFence(tx, input.fence);
    if (fence.sourceId !== input.sourceId) throw new Error("Discovery write fence belongs to another source.");
    const [document] = await tx.select().from(sourceDocuments).where(and(
      eq(sourceDocuments.id, input.sourceDocumentId),
      eq(sourceDocuments.accessScopeId, input.accessScopeId),
      eq(sourceDocuments.sourceId, input.sourceId),
    )).limit(1);
    if (!document) throw new Error("URL alias ownership does not match the logical document.");
    const [owner] = await tx.select().from(sourceDocumentUrlAliases).where(and(
      eq(sourceDocumentUrlAliases.accessScopeId, input.accessScopeId),
      eq(sourceDocumentUrlAliases.aliasUrl, aliasUrl),
    )).limit(1);
    if (owner && owner.sourceDocumentId !== document.id) {
      throw new Error("URL alias is already owned by another logical document in this access scope.");
    }
    await tx.insert(sourceDocumentUrlAliases).values({
      sourceDocumentId: document.id,
      accessScopeId: document.accessScopeId,
      sourceId: document.sourceId,
      aliasUrl,
      isCanonical: aliasUrl === document.canonicalUrl,
    }).onConflictDoNothing({
      target: [sourceDocumentUrlAliases.accessScopeId, sourceDocumentUrlAliases.aliasUrl],
    });
  });
}

/**
 * Register or reuse a verified raw artifact, create one immutable version, and
 * advance the document pointer while holding its row lock. Reusing an older
 * hash never changes the pointer, which prevents a delayed fetch moving current
 * backwards after a newer observation.
 */
export async function recordFetchedDocumentVersion(
  db: Database,
  input: RecordFetchedDocumentVersionInput,
): Promise<RecordFetchedDocumentVersionResult> {
  validateArtifactDescriptor(input.artifact);
  const observedAt = input.observedAt ?? new Date();

  return db.transaction(async (tx) => {
    const [document] = await tx.select().from(sourceDocuments)
      .where(eq(sourceDocuments.id, input.sourceDocumentId))
      .limit(1)
      .for("update");
    if (!document) throw new Error("Source document does not exist.");

    const [existingVersion] = await tx.select().from(documentVersions).where(and(
      eq(documentVersions.sourceDocumentId, document.id),
      eq(documentVersions.contentSha256, input.artifact.sha256),
    )).limit(1);
    if (existingVersion) return { version: existingVersion, created: false };

    await tx.insert(artifacts).values({
      artifactKey: input.artifact.key,
      uri: input.artifact.uri,
      sha256: input.artifact.sha256,
      byteSize: input.artifact.byteSize,
      mediaType: input.artifact.mediaType,
      producerVersion: input.artifact.producerVersion,
      verifiedAt: observedAt,
    }).onConflictDoNothing({ target: artifacts.artifactKey });
    const [artifact] = await tx.select().from(artifacts)
      .where(eq(artifacts.artifactKey, input.artifact.key)).limit(1);
    if (!artifact || !artifactMatches(artifact, input.artifact)) {
      throw new Error("Artifact metadata conflicts with the immutable stored object.");
    }

    const [latest] = await tx.select({ sequence: documentVersions.sequence })
      .from(documentVersions)
      .where(eq(documentVersions.sourceDocumentId, document.id))
      .orderBy(desc(documentVersions.sequence))
      .limit(1);
    const sequence = (latest?.sequence ?? 0) + 1;
    const [version] = await tx.insert(documentVersions).values({
      sourceDocumentId: document.id,
      accessScopeId: document.accessScopeId,
      sourceId: document.sourceId,
      sequence,
      contentSha256: input.artifact.sha256,
      rawArtifactId: artifact.id,
      etag: input.etag ?? null,
      lastModified: input.lastModified ?? null,
      observedAt,
      readyAt: observedAt,
    }).returning();
    if (!version) throw new Error("Failed to create document version.");

    const [advanced] = await tx.update(sourceDocuments).set({
      currentVersionId: version.id,
      updatedAt: observedAt,
    }).where(and(
      eq(sourceDocuments.id, document.id),
      sql`${sourceDocuments.currentVersionId} IS NOT DISTINCT FROM ${document.currentVersionId}`,
    )).returning({ id: sourceDocuments.id });
    if (!advanced) throw new Error("Document version fence changed while creating a version.");

    return { version, created: true };
  });
}

/** Atomically records immutable version metadata and its compatible PARSE work under the source lease fence. */
export async function recordFetchedDocumentVersionAndEnsurePipeline(
  db: Database,
  input: RecordFetchedDocumentVersionAndEnsurePipelineInput,
): Promise<RecordFetchedDocumentVersionResult> {
  validateArtifactDescriptor(input.artifact);
  validatePipelineIdentity(input.pipelineIdentity, input.artifact.sha256);
  const observedAt = input.observedAt ?? new Date();
  return db.transaction(async (tx) => {
    const fence = await assertDiscoveryWriteFence(tx, input.fence);
    const [document] = await tx.select().from(sourceDocuments)
      .where(eq(sourceDocuments.id, input.sourceDocumentId)).limit(1).for("update");
    if (!document) throw new Error("Source document does not exist.");
    if (document.sourceId !== fence.sourceId) throw new Error("Discovery write fence belongs to another source.");
    let [version] = await tx.select().from(documentVersions).where(and(
      eq(documentVersions.sourceDocumentId, document.id),
      eq(documentVersions.contentSha256, input.artifact.sha256),
    )).limit(1);
    let created = false;
    if (!version) {
      await tx.insert(artifacts).values({
        artifactKey: input.artifact.key, uri: input.artifact.uri,
        sha256: input.artifact.sha256, byteSize: input.artifact.byteSize,
        mediaType: input.artifact.mediaType, producerVersion: input.artifact.producerVersion,
        verifiedAt: observedAt,
      }).onConflictDoNothing({ target: artifacts.artifactKey });
      const [storedArtifact] = await tx.select().from(artifacts)
        .where(eq(artifacts.artifactKey, input.artifact.key)).limit(1);
      if (!storedArtifact || !artifactMatches(storedArtifact, input.artifact)) {
        throw new Error("Artifact metadata conflicts with the immutable stored object.");
      }
      const [latest] = await tx.select({ sequence: documentVersions.sequence })
        .from(documentVersions).where(eq(documentVersions.sourceDocumentId, document.id))
        .orderBy(desc(documentVersions.sequence)).limit(1);
      [version] = await tx.insert(documentVersions).values({
        sourceDocumentId: document.id, accessScopeId: document.accessScopeId,
        sourceId: document.sourceId, sequence: (latest?.sequence ?? 0) + 1,
        contentSha256: input.artifact.sha256, rawArtifactId: storedArtifact.id,
        configRevisionId: fence.configRevisionId,
        etag: input.etag ?? null, lastModified: input.lastModified ?? null,
        observedAt, readyAt: observedAt,
      }).returning();
      if (!version) throw new Error("Failed to create document version.");
      const [advanced] = await tx.update(sourceDocuments).set({
        currentVersionId: version.id, updatedAt: observedAt,
      }).where(and(
        eq(sourceDocuments.id, document.id),
        sql`${sourceDocuments.currentVersionId} IS NOT DISTINCT FROM ${document.currentVersionId}`,
      )).returning({ id: sourceDocuments.id });
      if (!advanced) throw new Error("Document version fence changed while creating a version.");
      created = true;
    }
    await ensureParsePipeline(
      tx,
      version,
      input.pipelineIdentity,
      input.artifact.sha256,
      fence.configRevisionId,
      observedAt,
    );
    return { version, created };
  });
}

/** Re-enqueue-compatible work for unchanged bytes, including after a crash between earlier writes. */
export async function ensureDocumentVersionPipelineForDiscovery(
  db: Database,
  input: EnsureDocumentVersionPipelineForDiscoveryInput,
): Promise<void> {
  validatePipelineIdentity(input.pipelineIdentity, input.inputChecksum);
  await db.transaction(async (tx) => {
    const fence = await assertDiscoveryWriteFence(tx, input.fence);
    const [version] = await tx.select().from(documentVersions)
      .where(and(eq(documentVersions.id, input.documentVersionId), eq(documentVersions.contentSha256, input.inputChecksum)))
      .limit(1);
    if (!version) throw new Error("Current document version does not match the unchanged fetch checksum.");
    if (version.sourceId !== fence.sourceId) throw new Error("Discovery write fence belongs to another source.");
    await ensureParsePipeline(
      tx,
      version,
      input.pipelineIdentity,
      input.inputChecksum,
      fence.configRevisionId,
      new Date(),
    );
  });
}

/**
 * Explicit pointer fence for later stage completions. Only a strictly newer
 * version belonging to the same logical document can replace expected current.
 */
export async function compareAndSetCurrentDocumentVersion(
  db: Database,
  input: CompareAndSetCurrentDocumentVersionInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [document] = await tx.select().from(sourceDocuments)
      .where(eq(sourceDocuments.id, input.sourceDocumentId))
      .limit(1)
      .for("update");
    if (!document || document.currentVersionId !== input.expectedCurrentVersionId) return false;

    const [proposed] = await tx.select().from(documentVersions).where(and(
      eq(documentVersions.id, input.proposedVersionId),
      eq(documentVersions.sourceDocumentId, input.sourceDocumentId),
    )).limit(1);
    if (!proposed) return false;

    const current = document.currentVersionId
      ? (await tx.select().from(documentVersions)
        .where(eq(documentVersions.id, document.currentVersionId)).limit(1))[0]
      : undefined;
    if (current && proposed.sequence <= current.sequence) return false;

    const [updated] = await tx.update(sourceDocuments).set({
      currentVersionId: proposed.id,
      updatedAt: new Date(),
    }).where(and(
      eq(sourceDocuments.id, input.sourceDocumentId),
      sql`${sourceDocuments.currentVersionId} IS NOT DISTINCT FROM ${input.expectedCurrentVersionId}`,
    )).returning({ id: sourceDocuments.id });
    return Boolean(updated);
  });
}

/** Record presence and validators once per successful discovery run/document. */
export async function recordDocumentObservation(
  db: Database,
  input: RecordDocumentObservationInput,
): Promise<typeof documentObservations.$inferSelect> {
  const observedUrl = canonicalHttpUrl(input.observedUrl);
  const observedAt = input.observedAt ?? new Date();

  return db.transaction(async (tx) => {
    const [ownership] = await tx.select({ document: sourceDocuments, run: discoveryRuns })
      .from(sourceDocuments)
      .innerJoin(discoveryRuns, eq(discoveryRuns.sourceId, sourceDocuments.sourceId))
      .where(and(
        eq(sourceDocuments.id, input.sourceDocumentId),
        eq(discoveryRuns.id, input.discoveryRunId),
      )).limit(1);
    if (!ownership) {
      throw new Error("Document observation ownership does not match the discovery run source.");
    }
    const { document, run } = ownership;
    if (run.status !== "succeeded") {
      throw new Error("Legacy single-document observations require a succeeded discovery run.");
    }

    const [observation] = await tx.insert(documentObservations).values({
      discoveryRunId: run.id,
      sourceDocumentId: document.id,
      accessScopeId: document.accessScopeId,
      sourceId: document.sourceId,
      observedUrl,
      etag: input.etag ?? null,
      lastModified: input.lastModified ?? null,
      observedAt,
    }).onConflictDoUpdate({
      target: [documentObservations.discoveryRunId, documentObservations.sourceDocumentId],
      set: {
        observedUrl,
        etag: input.etag ?? null,
        lastModified: input.lastModified ?? null,
        observedAt,
      },
    }).returning();
    if (!observation) throw new Error("Failed to record document observation.");
    return observation;
  });
}

/**
 * Persist one complete presence set and mark its fenced run successful in the
 * same transaction. Partial attempts call nothing, so future absence counters
 * cannot be advanced by a failed run.
 */
export async function recordSuccessfulDocumentObservations(
  db: Database,
  input: RecordSuccessfulDocumentObservationsInput,
): Promise<void> {
  const ids = input.observations.map((observation) => observation.sourceDocumentId);
  if (new Set(ids).size !== ids.length) throw new Error("Successful discovery contains duplicate document observations.");
  await db.transaction(async (tx) => {
    await assertDiscoveryWriteFence(tx, input);
    const [run] = await tx.select().from(discoveryRuns)
      .where(eq(discoveryRuns.id, input.discoveryRunId)).limit(1);
    if (!run) throw new Error("Discovery run does not exist.");
    for (const observation of input.observations) {
      const observedUrl = canonicalHttpUrl(observation.observedUrl);
      const [document] = await tx.select().from(sourceDocuments).where(and(
        eq(sourceDocuments.id, observation.sourceDocumentId),
        eq(sourceDocuments.sourceId, run.sourceId),
      )).limit(1);
      if (!document) throw new Error("Document observation ownership does not match the discovery run source.");
      await tx.insert(documentObservations).values({
        discoveryRunId: run.id,
        sourceDocumentId: document.id,
        accessScopeId: document.accessScopeId,
        sourceId: document.sourceId,
        observedUrl,
        etag: observation.etag ?? null,
        lastModified: observation.lastModified ?? null,
        observedAt: observation.observedAt ?? new Date(),
      }).onConflictDoUpdate({
        target: [documentObservations.discoveryRunId, documentObservations.sourceDocumentId],
        set: {
          observedUrl,
          etag: observation.etag ?? null,
          lastModified: observation.lastModified ?? null,
          observedAt: observation.observedAt ?? new Date(),
        },
      });
    }
    const completedAt = new Date();
    const [completed] = await tx.update(discoveryRuns).set({
      status: "succeeded",
      terminalDisposition: "SUCCEEDED",
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: completedAt,
      completedAt,
      errorCode: null,
      errorMessage: null,
    }).where(and(
      eq(discoveryRuns.id, input.discoveryRunId),
      eq(discoveryRuns.status, "running"),
      eq(discoveryRuns.leaseOwner, input.owner),
      eq(discoveryRuns.leaseEpoch, input.leaseEpoch),
    )).returning({ id: discoveryRuns.id });
    if (!completed) throw new Error("Discovery completion fence became stale.");
  });
}

/**
 * Read-only expand-phase audit. Legacy identity is never guessed or rewritten:
 * operators receive deterministic issue rows to resolve before writer cutover.
 */
export async function auditLegacyDocumentVersionReadiness(
  db: Database,
): Promise<readonly LegacyDocumentVersionIssue[]> {
  const [pdfRows, htmlRows] = await Promise.all([
    db.select({
      id: documents.id,
      hash: documents.fileHash,
      url: documents.sourceUrl,
      visibilityScope: documents.visibilityScope,
      tenantId: documents.tenantId,
    }).from(documents),
    db.select({
      id: htmlDocuments.id,
      hash: htmlDocuments.fileHash,
      url: htmlDocuments.sourceUrl,
      visibilityScope: htmlDocuments.visibilityScope,
      tenantId: htmlDocuments.tenantId,
    }).from(htmlDocuments),
  ]);
  const rows = [...pdfRows, ...htmlRows];
  const issues: LegacyDocumentVersionIssue[] = [];

  for (const row of rows) {
    if (row.visibilityScope === "UNCLASSIFIED" || (row.visibilityScope === "TENANT" && !row.tenantId)) {
      issues.push({
        kind: "UNRESOLVED_OWNERSHIP",
        value: row.visibilityScope,
        legacyDocumentIds: [row.id],
      });
    }
  }
  issues.push(...groupedLegacyIssues(rows, "url", "AMBIGUOUS_CANONICAL_URL"));
  issues.push(...groupedLegacyIssues(rows, "hash", "GLOBAL_CONTENT_COLLISION"));
  return issues.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value));
}

function validateArtifactDescriptor(descriptor: ArtifactDescriptor): void {
  if (!descriptor.key || !descriptor.uri || !descriptor.mediaType || !descriptor.producerVersion) {
    throw new Error("Artifact descriptor is incomplete.");
  }
  if (!SHA256_PATTERN.test(descriptor.sha256)) throw new Error("Artifact checksum must be lowercase SHA-256.");
  if (!Number.isSafeInteger(descriptor.byteSize) || descriptor.byteSize < 0) {
    throw new Error("Artifact byte size must be a non-negative safe integer.");
  }
}

function artifactMatches(
  stored: typeof artifacts.$inferSelect,
  descriptor: ArtifactDescriptor,
): boolean {
  return stored.uri === descriptor.uri
    && stored.sha256 === descriptor.sha256
    && stored.byteSize === descriptor.byteSize
    && stored.mediaType === descriptor.mediaType
    && stored.producerVersion === descriptor.producerVersion;
}

function canonicalHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Document URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Document URL must not contain inline credentials.");
  }
  parsed.hash = "";
  return parsed.toString();
}

function groupedLegacyIssues(
  rows: readonly { id: string; url: string | null; hash: string }[],
  field: "url" | "hash",
  kind: LegacyDocumentVersionIssueKind,
): LegacyDocumentVersionIssue[] {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const value = row[field];
    if (!value) continue;
    const identities = grouped.get(value) ?? [];
    identities.push(row.id);
    grouped.set(value, identities);
  }
  return [...grouped.entries()]
    .filter(([, identities]) => identities.length > 1)
    .map(([value, legacyDocumentIds]) => ({ kind, value, legacyDocumentIds }));
}

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function assertDiscoveryWriteFence(tx: DatabaseTransaction, fence: DiscoveryWriteFence): Promise<{
  readonly sourceId: string;
  readonly configRevisionId: string;
}> {
  const [run] = await tx.select({
    id: discoveryRuns.id,
    sourceId: discoveryRuns.sourceId,
    configRevisionId: discoveryRuns.configRevisionId,
  }).from(discoveryRuns).where(and(
    eq(discoveryRuns.id, fence.discoveryRunId),
    eq(discoveryRuns.status, "running"),
    eq(discoveryRuns.leaseOwner, fence.owner),
    eq(discoveryRuns.leaseEpoch, fence.leaseEpoch),
  )).limit(1).for("update");
  if (!run) throw new Error("Discovery write fence is stale.");
  return { sourceId: run.sourceId, configRevisionId: run.configRevisionId };
}

async function ensureParsePipeline(
  tx: DatabaseTransaction,
  version: typeof documentVersions.$inferSelect,
  identity: PipelineIdentityInput,
  inputChecksum: string,
  configRevisionId: string,
  now: Date,
): Promise<void> {
  const [insertedRun] = await tx.insert(pipelineRuns).values({
    documentVersionId: version.id, accessScopeId: version.accessScopeId, sourceId: version.sourceId,
    implementationVersion: identity.pipelineImplementationVersion,
    configRevisionId,
    initialStage: "PARSE", initialStageImplementationVersion: identity.parseImplementationVersion,
    initialInputChecksum: inputChecksum, initialMaxAttempts: identity.maxAttempts, status: "active",
  }).onConflictDoNothing({
    target: [pipelineRuns.documentVersionId, pipelineRuns.implementationVersion],
  }).returning();
  const run = insertedRun ?? (await tx.select().from(pipelineRuns).where(and(
    eq(pipelineRuns.documentVersionId, version.id),
    eq(pipelineRuns.implementationVersion, identity.pipelineImplementationVersion),
  )).limit(1))[0];
  if (!run || run.initialStage !== "PARSE"
    || run.initialStageImplementationVersion !== identity.parseImplementationVersion
    || run.initialInputChecksum !== inputChecksum
    || run.initialMaxAttempts !== identity.maxAttempts
    || run.configRevisionId !== configRevisionId) {
    throw new Error("Existing pipeline run initial PARSE contract does not match fetched version input.");
  }
  const [existing] = await tx.select().from(stageAttempts).where(and(
    eq(stageAttempts.pipelineRunId, run.id), eq(stageAttempts.stage, "PARSE"), eq(stageAttempts.isCurrent, true),
  )).limit(1);
  if (existing) return;
  const [attempt] = await tx.insert(stageAttempts).values({
    pipelineRunId: run.id, documentVersionId: version.id,
    accessScopeId: version.accessScopeId, sourceId: version.sourceId,
    stage: "PARSE", implementationVersion: identity.parseImplementationVersion,
    inputChecksum, maxAttempts: identity.maxAttempts, nextRunAt: now,
  }).onConflictDoNothing().returning();
  if (!attempt) throw new Error("Failed to ensure initial PARSE attempt.");
}

function validatePipelineIdentity(identity: PipelineIdentityInput, checksum: string): void {
  if (!identity.pipelineImplementationVersion.trim() || !identity.parseImplementationVersion.trim()) {
    throw new Error("Pipeline and PARSE implementation versions are required.");
  }
  if (!Number.isSafeInteger(identity.maxAttempts) || identity.maxAttempts <= 0) {
    throw new Error("Pipeline maximum attempts must be positive.");
  }
  if (!SHA256_PATTERN.test(checksum)) throw new Error("Pipeline input checksum must be lowercase SHA-256.");
}

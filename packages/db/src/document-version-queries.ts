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
    const [document] = await tx.select().from(sourceDocuments)
      .where(eq(sourceDocuments.id, input.sourceDocumentId)).limit(1);
    const [run] = await tx.select().from(discoveryRuns)
      .where(eq(discoveryRuns.id, input.discoveryRunId)).limit(1);
    if (!document || !run || run.sourceId !== document.sourceId) {
      throw new Error("Document observation ownership does not match the discovery run source.");
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

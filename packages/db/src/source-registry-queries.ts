import { createHash } from "node:crypto";

import type {
  AccessScopeManifest,
  DesiredSourceRegistry,
  SourceManifest,
} from "@mf-rag/types";
import { and, asc, eq, inArray, lte, ne, notExists, sql } from "drizzle-orm";
import { parseExpression } from "cron-parser";

import type { Database } from "./client.ts";
import {
  accessScopes,
  discoveryRuns,
  sourceRegistryRevisions,
  sourceSchedules,
  sources,
} from "./schema.ts";

const RECONCILIATION_LOCK = "mf-rag:source-registry-reconciliation:v1";
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const EXTERNAL_CODE_PATTERN = /^\d{1,20}$/;

export interface ReconcileSourceRegistryResult {
  readonly revisionId: string;
  readonly checksum: string;
  readonly changed: boolean;
}

export interface ClaimDueDiscoveryRunInput {
  readonly now?: Date;
}

export interface ClaimedDiscoveryRun {
  readonly run: typeof discoveryRuns.$inferSelect;
  readonly source: typeof sources.$inferSelect;
  readonly accessScope: typeof accessScopes.$inferSelect;
  readonly scheduledFor: Date;
  readonly nextDueAt: Date;
}

interface PreparedSourceRegistryRevision {
  readonly checksum: string;
  readonly desiredState: DesiredSourceRegistry;
}

/**
 * Validates and canonicalizes the full desired state before a database
 * transaction is opened. This keeps malformed deployments all-or-nothing.
 */
export function prepareSourceRegistryRevision(
  input: DesiredSourceRegistry,
): PreparedSourceRegistryRevision {
  validateDesiredRegistry(input);
  const desiredState = canonicalRegistry(input);
  const serialized = JSON.stringify(desiredState);
  return {
    checksum: createHash("sha256").update(serialized).digest("hex"),
    desiredState,
  };
}

export async function reconcileSourceRegistry(
  db: Database,
  desired: DesiredSourceRegistry,
): Promise<ReconcileSourceRegistryResult> {
  const prepared = prepareSourceRegistryRevision(desired);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECONCILIATION_LOCK}))`);

    const [active] = await tx.select({
      id: sourceRegistryRevisions.id,
      checksum: sourceRegistryRevisions.checksum,
    }).from(sourceRegistryRevisions).where(eq(sourceRegistryRevisions.isActive, true)).limit(1);

    if (active?.checksum === prepared.checksum) {
      return { revisionId: active.id, checksum: active.checksum, changed: false };
    }

    let [revision] = await tx.select().from(sourceRegistryRevisions)
      .where(eq(sourceRegistryRevisions.checksum, prepared.checksum)).limit(1);
    if (!revision) {
      [revision] = await tx.insert(sourceRegistryRevisions).values({
        checksum: prepared.checksum,
        desiredState: prepared.desiredState,
      }).returning();
    }
    if (!revision) throw new Error("Failed to create source-registry revision.");

    const reconciledAt = new Date();
    for (const desiredScope of prepared.desiredState.accessScopes) {
      const [existingScope] = await tx.select({
        externalCode: accessScopes.externalCode,
      }).from(accessScopes).where(eq(accessScopes.accessScopeKey, desiredScope.accessScopeKey)).limit(1);
      if (existingScope && existingScope.externalCode !== desiredScope.externalCode) {
        throw new Error(
          `Access scope ${desiredScope.accessScopeKey} cannot change external code from ${existingScope.externalCode} to ${desiredScope.externalCode}.`,
        );
      }
      const [scope] = await tx.insert(accessScopes).values({
        accessScopeKey: desiredScope.accessScopeKey,
        externalCode: desiredScope.externalCode,
        tenantId: desiredScope.tenantId,
        knowledgeDomain: desiredScope.classification.knowledgeDomain,
        sourceCollection: desiredScope.classification.sourceCollection,
        amcSlug: desiredScope.classification.amcSlug,
        enabled: true,
        configRevisionId: revision.id,
      }).onConflictDoUpdate({
        target: accessScopes.accessScopeKey,
        set: {
          externalCode: desiredScope.externalCode,
          tenantId: desiredScope.tenantId,
          knowledgeDomain: desiredScope.classification.knowledgeDomain,
          sourceCollection: desiredScope.classification.sourceCollection,
          amcSlug: desiredScope.classification.amcSlug,
          enabled: true,
          configRevisionId: revision.id,
          updatedAt: reconciledAt,
        },
      }).returning();
      if (!scope) throw new Error(`Failed to reconcile access scope ${desiredScope.accessScopeKey}.`);
      for (const desiredSource of desiredScope.sources) {
        const [source] = await tx.insert(sources).values({
          accessScopeId: scope.id,
          sourceKey: desiredSource.sourceKey,
          connector: desiredSource.connector,
          discoveryConfig: desiredSource.discovery,
          fetchConfig: desiredSource.fetch,
          reviewConfig: desiredSource.review,
          enabled: desiredSource.enabled,
          configRevisionId: revision.id,
        }).onConflictDoUpdate({
          target: [sources.accessScopeId, sources.sourceKey],
          set: {
            connector: desiredSource.connector,
            discoveryConfig: desiredSource.discovery,
            fetchConfig: desiredSource.fetch,
            reviewConfig: desiredSource.review,
            enabled: desiredSource.enabled,
            configRevisionId: revision.id,
            updatedAt: reconciledAt,
          },
        }).returning();
        if (!source) throw new Error(`Failed to reconcile source ${desiredSource.sourceKey}.`);

        const [existingSchedule] = await tx.select().from(sourceSchedules)
          .where(eq(sourceSchedules.sourceId, source.id)).limit(1);
        const cadenceChanged = existingSchedule?.cron !== desiredSource.schedule.cron
          || existingSchedule.timezone !== desiredSource.schedule.timezone
          || (!existingSchedule.enabled && desiredSource.schedule.enabled);
        const nextDueAt = existingSchedule && !cadenceChanged
          ? existingSchedule.nextDueAt
          : nextOccurrence(desiredSource.schedule.cron, desiredSource.schedule.timezone, reconciledAt);

        await tx.insert(sourceSchedules).values({
          sourceId: source.id,
          enabled: desiredSource.enabled && desiredSource.schedule.enabled,
          cron: desiredSource.schedule.cron,
          timezone: desiredSource.schedule.timezone,
          nextDueAt,
        }).onConflictDoUpdate({
          target: sourceSchedules.sourceId,
          set: {
            enabled: desiredSource.enabled && desiredSource.schedule.enabled,
            cron: desiredSource.schedule.cron,
            timezone: desiredSource.schedule.timezone,
            nextDueAt,
            updatedAt: reconciledAt,
          },
        });
      }
    }

    await tx.update(accessScopes).set({ enabled: false, updatedAt: reconciledAt })
      .where(ne(accessScopes.configRevisionId, revision.id));
    await tx.update(sources).set({ enabled: false, updatedAt: reconciledAt })
      .where(ne(sources.configRevisionId, revision.id));
    await tx.execute(sql`
      UPDATE ${sourceSchedules}
      SET enabled = false, updated_at = ${reconciledAt}
      WHERE source_id IN (
        SELECT id FROM ${sources} WHERE enabled = false
      )
    `);

    await tx.update(sourceRegistryRevisions).set({
      isActive: false,
      supersededAt: reconciledAt,
    }).where(eq(sourceRegistryRevisions.isActive, true));
    await tx.update(sourceRegistryRevisions).set({
      isActive: true,
      supersededAt: null,
    }).where(eq(sourceRegistryRevisions.id, revision.id));

    return { revisionId: revision.id, checksum: revision.checksum, changed: true };
  });
}

/** Atomically claims one due source and advances its cadence beyond `now`. */
export async function claimDueDiscoveryRun(
  db: Database,
  input: ClaimDueDiscoveryRunInput = {},
): Promise<ClaimedDiscoveryRun | null> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({
      source: sources,
      accessScope: accessScopes,
      scheduledFor: sourceSchedules.nextDueAt,
      cron: sourceSchedules.cron,
      timezone: sourceSchedules.timezone,
    }).from(sourceSchedules)
      .innerJoin(sources, eq(sources.id, sourceSchedules.sourceId))
      .innerJoin(accessScopes, eq(accessScopes.id, sources.accessScopeId))
      .where(and(
        eq(sourceSchedules.enabled, true),
        eq(sources.enabled, true),
        eq(accessScopes.enabled, true),
        lte(sourceSchedules.nextDueAt, now),
        notExists(
          tx.select({ one: sql`1` }).from(discoveryRuns).where(and(
            eq(discoveryRuns.sourceId, sources.id),
            inArray(discoveryRuns.status, ["pending", "running"]),
          )),
        ),
      ))
      .orderBy(asc(sourceSchedules.nextDueAt), asc(sources.id))
      .limit(1)
      .for("update", { of: [sourceSchedules, sources, accessScopes], skipLocked: true });

    if (!candidate) return null;

    const nextDueAt = nextOccurrence(candidate.cron, candidate.timezone, now);
    const [run] = await tx.insert(discoveryRuns).values({
      sourceId: candidate.source.id,
      configRevisionId: candidate.source.configRevisionId,
      scheduledFor: candidate.scheduledFor,
      status: "pending",
    }).onConflictDoNothing({
      target: [discoveryRuns.sourceId, discoveryRuns.scheduledFor],
    }).returning();

    await tx.update(sourceSchedules).set({ nextDueAt, updatedAt: now })
      .where(eq(sourceSchedules.sourceId, candidate.source.id));

    if (!run) return null;
    return {
      run,
      source: candidate.source,
      accessScope: candidate.accessScope,
      scheduledFor: candidate.scheduledFor,
      nextDueAt,
    };
  });
}

function nextOccurrence(cron: string, timezone: string, after: Date): Date {
  return parseExpression(cron, { currentDate: after, tz: timezone }).next().toDate();
}

function validateDesiredRegistry(registry: DesiredSourceRegistry): void {
  if (!registry || registry.version !== 1 || !Array.isArray(registry.accessScopes) || registry.accessScopes.length === 0) {
    throw new Error("A source registry must contain at least one version-1 access scope.");
  }

  const scopeKeys = new Set<string>();
  const externalCodes = new Set<string>();
  for (const scope of registry.accessScopes) {
    if (!SLUG_PATTERN.test(scope.accessScopeKey)) throw new Error(`Invalid access-scope key: ${scope.accessScopeKey}`);
    if (!EXTERNAL_CODE_PATTERN.test(scope.externalCode)) throw new Error(`Invalid external code: ${scope.externalCode}`);
    if (scope.tenantId !== scope.externalCode) throw new Error(`Tenant compatibility code must equal ${scope.externalCode}.`);
    if (scopeKeys.has(scope.accessScopeKey)) throw new Error(`Duplicate access-scope key: ${scope.accessScopeKey}`);
    if (externalCodes.has(scope.externalCode)) throw new Error(`Duplicate external code: ${scope.externalCode}`);
    scopeKeys.add(scope.accessScopeKey);
    externalCodes.add(scope.externalCode);

    const sourceKeys = new Set<string>();
    for (const source of scope.sources) {
      if (!SLUG_PATTERN.test(source.sourceKey)) throw new Error(`Invalid source key: ${source.sourceKey}`);
      if (sourceKeys.has(source.sourceKey)) throw new Error(`Duplicate source key ${source.sourceKey} in ${scope.accessScopeKey}.`);
      sourceKeys.add(source.sourceKey);
      nextOccurrence(source.schedule.cron, source.schedule.timezone, new Date(0));
      assertNoInlineSecrets(source);
    }
  }
}

function assertNoInlineSecrets(value: unknown, path: readonly string[] = []): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (["apikey", "authorization", "bearer", "clientsecret", "cookie", "cookies", "credential", "credentials", "password", "token"].includes(normalized)) {
      throw new Error(`Inline secret field ${[...path, key].join(".")} is forbidden.`);
    }
    assertNoInlineSecrets(child, [...path, key]);
  }
}

function canonicalRegistry(registry: DesiredSourceRegistry): DesiredSourceRegistry {
  return {
    version: 1,
    accessScopes: [...registry.accessScopes]
      .sort((left, right) => left.accessScopeKey.localeCompare(right.accessScopeKey))
      .map((scope) => canonicalScope(scope)),
  };
}

function canonicalScope(scope: AccessScopeManifest): AccessScopeManifest {
  return {
    apiVersion: scope.apiVersion,
    accessScopeKey: scope.accessScopeKey,
    externalCode: scope.externalCode,
    tenantId: scope.tenantId,
    classification: {
      knowledgeDomain: scope.classification.knowledgeDomain,
      sourceCollection: scope.classification.sourceCollection,
      amcSlug: scope.classification.amcSlug,
    },
    sources: [...scope.sources]
      .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey))
      .map(canonicalSource),
  };
}

function canonicalSource(source: SourceManifest): SourceManifest {
  return {
    sourceKey: source.sourceKey,
    connector: source.connector,
    enabled: source.enabled,
    discovery: source.discovery,
    schedule: source.schedule,
    fetch: source.fetch,
    review: source.review,
  };
}

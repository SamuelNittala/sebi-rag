import {
  discoveryRuns,
  documentPublicationGenerations,
  ingestionRuns,
  sources,
  sql,
  stageAttempts,
  type Database,
} from "@mf-rag/db";

import type { PipelineMetrics } from "./metrics.ts";

/** Derives operator metrics from durable state; worker logs are not the source of truth. */
export async function refreshPipelineMetrics(
  database: Database,
  metrics: PipelineMetrics,
  now = new Date(),
): Promise<void> {
  const [queueRows, discoveryRows, reviewRows, publicationRows, freshness, stageDurations] = await Promise.all([
    database.select({
      age: sql<number>`coalesce(extract(epoch from ${now}::timestamptz) - extract(epoch from (min(${stageAttempts.createdAt}) filter (where ${stageAttempts.status} in ('pending', 'retry_wait')))), 0)::float8`,
      retries: sql<number>`count(*) filter (where ${stageAttempts.terminalDisposition} = 'RETRY_SCHEDULED')::int`,
      deadLetters: sql<number>`count(*) filter (where ${stageAttempts.status} = 'dead_letter' and ${stageAttempts.isCurrent} = true)::int`,
      recoveredLeases: sql<number>`coalesce(sum(greatest(${stageAttempts.leaseEpoch} - 1, 0)), 0)::int`,
    }).from(stageAttempts),
    database.select({
      recoveredLeases: sql<number>`coalesce(sum(greatest(${discoveryRuns.leaseEpoch} - 1, 0)), 0)::int`,
    }).from(discoveryRuns),
    database.select({
      backlog: sql<number>`count(*) filter (where ${ingestionRuns.status} = 'review_ready')::int`,
    }).from(ingestionRuns),
    database.select({
      lag: sql<number>`coalesce(extract(epoch from ${now}::timestamptz) - extract(epoch from (min(${documentPublicationGenerations.stagedAt}) filter (where ${documentPublicationGenerations.status} = 'staged'))), 0)::float8`,
    }).from(documentPublicationGenerations),
    database.select({
      sourceId: sources.id,
      seconds: sql<number>`coalesce(extract(epoch from ${now}::timestamptz) - extract(epoch from (max(${discoveryRuns.completedAt}) filter (where ${discoveryRuns.status} = 'succeeded'))), 0)::float8`,
    }).from(sources).leftJoin(discoveryRuns, sql`${discoveryRuns.sourceId} = ${sources.id}`).groupBy(sources.id),
    database.select({
      stage: stageAttempts.stage,
      seconds: sql<number>`coalesce(avg(extract(epoch from (${stageAttempts.completedAt} - ${stageAttempts.startedAt}))) filter (where ${stageAttempts.completedAt} is not null and ${stageAttempts.startedAt} is not null), 0)::float8`,
    }).from(stageAttempts).groupBy(stageAttempts.stage),
  ]);
  const queue = queueRows[0];
  const discovery = discoveryRows[0];
  const review = reviewRows[0];
  const publication = publicationRows[0];

  metrics.set("pipeline_queue_age_seconds", Math.max(0, queue?.age ?? 0));
  metrics.set("pipeline_retries_total", queue?.retries ?? 0);
  metrics.set("pipeline_dead_letters_total", queue?.deadLetters ?? 0);
  metrics.set("pipeline_lease_recoveries_total", (queue?.recoveredLeases ?? 0) + (discovery?.recoveredLeases ?? 0));
  metrics.set("pipeline_review_backlog", review?.backlog ?? 0);
  metrics.set("pipeline_publication_lag_seconds", Math.max(0, publication?.lag ?? 0));
  for (const row of freshness) metrics.set("pipeline_source_freshness_seconds", Math.max(0, row.seconds), { source_id: row.sourceId });
  for (const row of stageDurations) metrics.set("pipeline_stage_duration_seconds", Math.max(0, row.seconds), { stage: row.stage });
}

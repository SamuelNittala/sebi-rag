import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";

import type { VisibilityScope } from "@mf-rag/types";

export type OwnershipSourceType = "pdf" | "html";
export type OwnershipTable =
  | "documents"
  | "html_documents"
  | "ingestion_runs"
  | "chunk_candidates"
  | "chunks"
  | "html_chunks";

export interface OwnershipInventoryRow {
  sourceType: OwnershipSourceType;
  documentId: string;
  fileHash: string;
  knowledgeDomain: string | null;
  sourceCollection: string | null;
  amcSlug: string | null;
  publicationState: string;
  table: OwnershipTable;
  count: number;
  visibilityScope: VisibilityScope;
  tenantId: string | null;
  ownershipManifestId: string | null;
  ownershipManifestVersion: number | null;
}

export interface OwnershipOrphan {
  table: OwnershipTable;
  rowId: string;
  reason: string;
}

export interface OwnershipInventory {
  rows: OwnershipInventoryRow[];
  orphans: OwnershipOrphan[];
}

interface PdfExpectedCounts {
  documents: number;
  ingestionRuns: number;
  chunkCandidates: number;
  chunks: number;
}

interface HtmlExpectedCounts {
  htmlDocuments: number;
  ingestionRuns: number;
  chunkCandidates: number;
  htmlChunks: number;
}

export interface TenantOwnershipManifestEntry {
  sourceType: OwnershipSourceType;
  documentId: string;
  fileHash: string;
  visibilityScope: "GLOBAL" | "TENANT";
  tenantId: string | null;
  expectedCounts: PdfExpectedCounts | HtmlExpectedCounts;
}

export interface TenantOwnershipManifest {
  manifestId: string;
  manifestVersion: number;
  approvedBy: string;
  approvedAt: string;
  inventoryChecksum: string;
  entries: TenantOwnershipManifestEntry[];
  manifestChecksum: string;
}

export interface OwnershipAuditResult {
  canApply: boolean;
  inventoryChecksum: string;
  unresolvedPublishedRows: number;
  errors: string[];
}

type QueryExecutor = {
  execute(query: ReturnType<typeof sql.raw>): Promise<unknown>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const TENANT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;

function normalizedForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedForCanonicalJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizedForCanonicalJson(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizedForCanonicalJson(value));
}

export async function computeManifestChecksum(value: unknown): Promise<string> {
  const unsigned =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "manifestChecksum"),
        )
      : value;
  const bytes = new TextEncoder().encode(canonicalJson(unsigned));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectedCountKey(
  sourceType: OwnershipSourceType,
  table: OwnershipTable,
): keyof PdfExpectedCounts | keyof HtmlExpectedCounts | null {
  if (table === "ingestion_runs") return "ingestionRuns";
  if (table === "chunk_candidates") return "chunkCandidates";
  if (sourceType === "pdf" && table === "documents") return "documents";
  if (sourceType === "pdf" && table === "chunks") return "chunks";
  if (sourceType === "html" && table === "html_documents") return "htmlDocuments";
  if (sourceType === "html" && table === "html_chunks") return "htmlChunks";
  return null;
}

function manifestEntryKey(entry: Pick<TenantOwnershipManifestEntry, "sourceType" | "documentId">) {
  return `${entry.sourceType}:${entry.documentId}`;
}

function rowOwnershipKey(row: OwnershipInventoryRow): string {
  return [
    row.visibilityScope,
    row.tenantId ?? "",
    row.ownershipManifestId ?? "",
    row.ownershipManifestVersion ?? "",
  ].join(":");
}

export async function validateOwnershipManifest(
  manifest: TenantOwnershipManifest,
): Promise<string[]> {
  const errors: string[] = [];
  if (!IDENTIFIER_PATTERN.test(manifest.manifestId)) errors.push("manifestId is invalid.");
  if (!Number.isInteger(manifest.manifestVersion) || manifest.manifestVersion < 1) {
    errors.push("manifestVersion must be a positive integer.");
  }
  if (!manifest.approvedBy.trim()) errors.push("approvedBy is required.");
  if (Number.isNaN(Date.parse(manifest.approvedAt))) errors.push("approvedAt must be an ISO date.");
  if (!HASH_PATTERN.test(manifest.inventoryChecksum)) errors.push("inventoryChecksum is invalid.");
  if (manifest.manifestChecksum !== await computeManifestChecksum(manifest)) {
    errors.push("manifest checksum does not match the reviewed manifest.");
  }

  const identities = new Set<string>();
  for (const entry of manifest.entries) {
    const identity = manifestEntryKey(entry);
    if (identities.has(identity)) errors.push(`duplicate document mapping: ${identity}.`);
    identities.add(identity);
    if (!UUID_PATTERN.test(entry.documentId)) errors.push(`invalid document ID: ${identity}.`);
    if (!HASH_PATTERN.test(entry.fileHash)) errors.push(`invalid file hash: ${identity}.`);
    if (entry.visibilityScope === "GLOBAL" && entry.tenantId !== null) {
      errors.push(`GLOBAL mapping ${identity} must not have a tenant ID.`);
    }
    if (
      entry.visibilityScope === "TENANT" &&
      (entry.tenantId === null || !TENANT_PATTERN.test(entry.tenantId))
    ) {
      errors.push(`TENANT mapping ${identity} requires one canonical tenant ID.`);
    }
    for (const [table, count] of Object.entries(entry.expectedCounts)) {
      if (!Number.isInteger(count) || count < 0) {
        errors.push(`${identity} expected count ${table} must be a non-negative integer.`);
      }
    }
  }
  return errors;
}

export async function auditOwnershipInventory(
  inventory: OwnershipInventory,
  manifest: TenantOwnershipManifest,
): Promise<OwnershipAuditResult> {
  const errors = await validateOwnershipManifest(manifest);
  const inventoryChecksum = await computeManifestChecksum(inventory);
  if (inventoryChecksum !== manifest.inventoryChecksum) {
    errors.push("inventory checksum is stale; ingestion or ownership data drifted after review.");
  }
  for (const orphan of inventory.orphans) {
    errors.push(`orphan ${orphan.table} row ${orphan.rowId}: ${orphan.reason}.`);
  }

  const entries = new Map(manifest.entries.map((entry) => [manifestEntryKey(entry), entry]));
  const rowsByDocument = Map.groupBy(
    inventory.rows,
    (row) => `${row.sourceType}:${row.documentId}`,
  );
  for (const [identity, rows] of rowsByDocument) {
    const entry = entries.get(identity);
    if (!entry) {
      errors.push(`unmapped legacy document: ${identity}.`);
      continue;
    }
    if (rows.some((row) => row.fileHash !== entry.fileHash)) {
      errors.push(`file hash drift for ${identity}.`);
    }
    const ownerships = new Set(rows.map(rowOwnershipKey));
    if (ownerships.size > 1) errors.push(`mixed ownership for ${identity}.`);
    const existingClassified = rows.filter((row) => row.visibilityScope !== "UNCLASSIFIED");
    if (existingClassified.length > 0) {
      errors.push(`conflicting existing ownership for ${identity}; only UNCLASSIFIED rows may change.`);
    }
    for (const [table, count] of Object.entries(entry.expectedCounts)) {
      const actual = rows
        .filter((row) => expectedCountKey(row.sourceType, row.table) === table)
        .reduce((sum, row) => sum + row.count, 0);
      if (actual !== count) {
        errors.push(`count drift for ${identity} ${table}: expected ${count}, found ${actual}.`);
      }
    }
  }
  for (const identity of entries.keys()) {
    if (!rowsByDocument.has(identity)) errors.push(`manifest document is missing: ${identity}.`);
  }

  const unresolvedPublishedRows = inventory.rows
    .filter(
      (row) =>
        row.publicationState === "published" && row.visibilityScope === "UNCLASSIFIED",
    )
    .reduce((sum, row) => sum + row.count, 0);
  return {
    canApply: errors.length === 0,
    inventoryChecksum,
    unresolvedPublishedRows,
    errors,
  };
}

interface RawInventoryRow {
  source_type: OwnershipSourceType;
  document_id: string;
  file_hash: string;
  knowledge_domain: string | null;
  source_collection: string | null;
  amc_slug: string | null;
  publication_state: string;
  table_name: OwnershipTable;
  row_count: string | number;
  visibility_scope: VisibilityScope;
  tenant_id: string | null;
  ownership_manifest_id: string | null;
  ownership_manifest_version: number | null;
}

interface RawOrphan {
  table_name: OwnershipTable;
  row_id: string;
  reason: string;
}

export async function loadOwnershipInventory(executor: QueryExecutor): Promise<OwnershipInventory> {
  const rowsResult = await executor.execute(sql.raw(`
    SELECT 'pdf'::text source_type, d.id document_id, d.file_hash,
      NULL::text knowledge_domain, NULL::text source_collection, NULL::text amc_slug,
      d.status publication_state, 'documents'::text table_name, count(*) row_count,
      d.visibility_scope, d.tenant_id, d.ownership_manifest_id, d.ownership_manifest_version
    FROM documents d
    GROUP BY d.id
    UNION ALL
    SELECT 'pdf', c.document_id, d.file_hash, c.knowledge_domain, c.source_collection, c.amc_slug,
      c.publication_status, 'chunks', count(*), c.visibility_scope, c.tenant_id,
      c.ownership_manifest_id, c.ownership_manifest_version
    FROM chunks c JOIN documents d ON d.id = c.document_id
    GROUP BY c.document_id, d.file_hash, c.knowledge_domain, c.source_collection, c.amc_slug,
      c.publication_status, c.visibility_scope, c.tenant_id, c.ownership_manifest_id,
      c.ownership_manifest_version
    UNION ALL
    SELECT 'html', d.id, d.file_hash, d.knowledge_domain, d.source_collection, d.amc_slug,
      d.status, 'html_documents', count(*), d.visibility_scope, d.tenant_id,
      d.ownership_manifest_id, d.ownership_manifest_version
    FROM html_documents d
    GROUP BY d.id
    UNION ALL
    SELECT 'html', c.document_id, d.file_hash, c.knowledge_domain, c.source_collection, c.amc_slug,
      c.publication_status, 'html_chunks', count(*), c.visibility_scope, c.tenant_id,
      c.ownership_manifest_id, c.ownership_manifest_version
    FROM html_chunks c JOIN html_documents d ON d.id = c.document_id
    GROUP BY c.document_id, d.file_hash, c.knowledge_domain, c.source_collection, c.amc_slug,
      c.publication_status, c.visibility_scope, c.tenant_id, c.ownership_manifest_id,
      c.ownership_manifest_version
    UNION ALL
    SELECT r.source_type, r.source_document_id, COALESCE(pd.file_hash, hd.file_hash),
      hd.knowledge_domain, hd.source_collection, hd.amc_slug, r.status, 'ingestion_runs', count(*),
      r.visibility_scope, r.tenant_id, r.ownership_manifest_id, r.ownership_manifest_version
    FROM ingestion_runs r
    LEFT JOIN documents pd ON r.source_type = 'pdf' AND pd.id = r.source_document_id
    LEFT JOIN html_documents hd ON r.source_type = 'html' AND hd.id = r.source_document_id
    WHERE pd.id IS NOT NULL OR hd.id IS NOT NULL
    GROUP BY r.source_type, r.source_document_id, pd.file_hash, hd.file_hash, hd.knowledge_domain,
      hd.source_collection, hd.amc_slug, r.status, r.visibility_scope, r.tenant_id,
      r.ownership_manifest_id, r.ownership_manifest_version
    UNION ALL
    SELECT r.source_type, r.source_document_id, COALESCE(pd.file_hash, hd.file_hash),
      hd.knowledge_domain, hd.source_collection, hd.amc_slug, r.status, 'chunk_candidates', count(*),
      c.visibility_scope, c.tenant_id, c.ownership_manifest_id, c.ownership_manifest_version
    FROM chunk_candidates c
    JOIN ingestion_runs r ON r.id = c.ingestion_run_id
    LEFT JOIN documents pd ON r.source_type = 'pdf' AND pd.id = r.source_document_id
    LEFT JOIN html_documents hd ON r.source_type = 'html' AND hd.id = r.source_document_id
    WHERE pd.id IS NOT NULL OR hd.id IS NOT NULL
    GROUP BY r.source_type, r.source_document_id, pd.file_hash, hd.file_hash, hd.knowledge_domain,
      hd.source_collection, hd.amc_slug, r.status, c.visibility_scope, c.tenant_id,
      c.ownership_manifest_id, c.ownership_manifest_version
    ORDER BY source_type, document_id, table_name, publication_state
  `)) as { rows?: RawInventoryRow[] } | RawInventoryRow[];
  const rawRows = Array.isArray(rowsResult) ? rowsResult : rowsResult.rows ?? [];

  const orphanResult = await executor.execute(sql.raw(`
    SELECT 'chunks'::text table_name, c.id row_id, 'missing document'::text reason
      FROM chunks c LEFT JOIN documents d ON d.id = c.document_id WHERE d.id IS NULL
    UNION ALL
    SELECT 'html_chunks', c.id, 'missing HTML document'
      FROM html_chunks c LEFT JOIN html_documents d ON d.id = c.document_id WHERE d.id IS NULL
    UNION ALL
    SELECT 'ingestion_runs', r.id, 'missing typed source document'
      FROM ingestion_runs r
      LEFT JOIN documents pd ON r.source_type = 'pdf' AND pd.id = r.source_document_id
      LEFT JOIN html_documents hd ON r.source_type = 'html' AND hd.id = r.source_document_id
      WHERE pd.id IS NULL AND hd.id IS NULL
    UNION ALL
    SELECT 'chunk_candidates', c.id, 'missing ingestion run'
      FROM chunk_candidates c LEFT JOIN ingestion_runs r ON r.id = c.ingestion_run_id
      WHERE r.id IS NULL
  `)) as { rows?: RawOrphan[] } | RawOrphan[];
  const rawOrphans = Array.isArray(orphanResult) ? orphanResult : orphanResult.rows ?? [];

  return {
    rows: rawRows.map((row) => ({
      sourceType: row.source_type,
      documentId: row.document_id,
      fileHash: row.file_hash,
      knowledgeDomain: row.knowledge_domain,
      sourceCollection: row.source_collection,
      amcSlug: row.amc_slug,
      publicationState: row.publication_state,
      table: row.table_name,
      count: Number(row.row_count),
      visibilityScope: row.visibility_scope,
      tenantId: row.tenant_id,
      ownershipManifestId: row.ownership_manifest_id,
      ownershipManifestVersion: row.ownership_manifest_version,
    })),
    orphans: rawOrphans.map((orphan) => ({
      table: orphan.table_name,
      rowId: orphan.row_id,
      reason: orphan.reason,
    })),
  };
}

async function updateEntry(
  tx: QueryExecutor,
  manifest: TenantOwnershipManifest,
  entry: TenantOwnershipManifestEntry,
) {
  const tenant = entry.tenantId === null ? sql`NULL` : sql`${entry.tenantId}`;
  const ownership = sql`
    visibility_scope = ${entry.visibilityScope},
    tenant_id = ${tenant},
    ownership_manifest_id = ${manifest.manifestId},
    ownership_manifest_version = ${manifest.manifestVersion}
  `;
  if (entry.sourceType === "pdf") {
    await tx.execute(sql`UPDATE documents SET ${ownership}
      WHERE id = ${entry.documentId} AND file_hash = ${entry.fileHash}
        AND visibility_scope = 'UNCLASSIFIED'`);
    await tx.execute(sql`UPDATE chunks SET ${ownership}
      WHERE document_id = ${entry.documentId} AND visibility_scope = 'UNCLASSIFIED'`);
  } else {
    await tx.execute(sql`UPDATE html_documents SET ${ownership}
      WHERE id = ${entry.documentId} AND file_hash = ${entry.fileHash}
        AND visibility_scope = 'UNCLASSIFIED'`);
    await tx.execute(sql`UPDATE html_chunks SET ${ownership}
      WHERE document_id = ${entry.documentId} AND visibility_scope = 'UNCLASSIFIED'`);
  }
  await tx.execute(sql`UPDATE ingestion_runs SET ${ownership}
    WHERE source_type = ${entry.sourceType}
      AND source_document_id = ${entry.documentId}
      AND visibility_scope = 'UNCLASSIFIED'`);
  await tx.execute(sql`UPDATE chunk_candidates SET ${ownership}
    WHERE ingestion_run_id IN (
      SELECT id FROM ingestion_runs
      WHERE source_type = ${entry.sourceType} AND source_document_id = ${entry.documentId}
    ) AND visibility_scope = 'UNCLASSIFIED'`);
}

function classificationErrors(
  inventory: OwnershipInventory,
  manifest: TenantOwnershipManifest,
): string[] {
  const entries = new Map(manifest.entries.map((entry) => [manifestEntryKey(entry), entry]));
  const errors: string[] = [];
  for (const row of inventory.rows) {
    const identity = `${row.sourceType}:${row.documentId}`;
    const entry = entries.get(identity);
    if (!entry) {
      errors.push(`unmapped row after apply: ${identity} ${row.table}.`);
      continue;
    }
    if (
      row.visibilityScope !== entry.visibilityScope ||
      row.tenantId !== entry.tenantId ||
      row.ownershipManifestId !== manifest.manifestId ||
      row.ownershipManifestVersion !== manifest.manifestVersion
    ) {
      errors.push(`ownership mismatch after apply: ${identity} ${row.table}.`);
    }
  }
  if (inventory.orphans.length > 0) errors.push("orphans remain after apply.");
  return errors;
}

export async function applyOwnershipManifest(
  database: ReturnType<typeof drizzle>,
  manifest: TenantOwnershipManifest,
): Promise<"applied" | "no-op"> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('tenant-ownership-backfill', 0))`);
    await tx.execute(sql.raw(`
      LOCK TABLE documents, chunks, html_documents, html_chunks, ingestion_runs, chunk_candidates
      IN SHARE ROW EXCLUSIVE MODE
    `));
    const replay = await tx.execute(sql`
      SELECT manifest_checksum
      FROM tenant_ownership_manifest_applications
      WHERE manifest_id = ${manifest.manifestId}
        AND manifest_version = ${manifest.manifestVersion}
    `) as unknown as Array<{ manifest_checksum: string }>;
    if (replay.length > 0) {
      if (replay[0]?.manifest_checksum !== manifest.manifestChecksum) {
        throw new Error("A different manifest already uses this manifest ID and version.");
      }
      const current = await loadOwnershipInventory(tx);
      const errors = classificationErrors(current, manifest);
      if (errors.length > 0) throw new Error(errors.join("\n"));
      return "no-op";
    }

    const before = await loadOwnershipInventory(tx);
    const audit = await auditOwnershipInventory(before, manifest);
    if (!audit.canApply) throw new Error(audit.errors.join("\n"));
    for (const entry of manifest.entries) await updateEntry(tx, manifest, entry);
    const after = await loadOwnershipInventory(tx);
    const errors = classificationErrors(after, manifest);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    await tx.execute(sql`
      INSERT INTO tenant_ownership_manifest_applications (
        manifest_id, manifest_version, manifest_checksum, inventory_checksum, approved_by, approved_at
      ) VALUES (
        ${manifest.manifestId}, ${manifest.manifestVersion}, ${manifest.manifestChecksum},
        ${manifest.inventoryChecksum}, ${manifest.approvedBy}, ${new Date(manifest.approvedAt)}
      )
    `);
    return "applied";
  });
}

function parseCliArgs(args: string[]) {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  return {
    apply: args.includes("--apply"),
    manifestPath: value("--manifest"),
    inventoryOutput: value("--inventory-output"),
    databaseUrl: value("--database-url") ?? process.env.DATABASE_URL,
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.databaseUrl) throw new Error("DATABASE_URL or --database-url is required.");
  const client = new SQL(options.databaseUrl);
  const database = drizzle({ client });
  try {
    const inventory = await loadOwnershipInventory(database);
    const report = {
      generatedAt: new Date().toISOString(),
      inventoryChecksum: await computeManifestChecksum(inventory),
      inventory,
    };
    if (options.inventoryOutput) {
      await Bun.write(options.inventoryOutput, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (!options.manifestPath) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const manifest = await Bun.file(options.manifestPath).json() as TenantOwnershipManifest;
    const audit = await auditOwnershipInventory(inventory, manifest);
    if (!audit.canApply) throw new Error(audit.errors.join("\n"));
    if (!options.apply) {
      console.log(JSON.stringify({ mode: "dry-run", ...audit }, null, 2));
      return;
    }
    const result = await applyOwnershipManifest(database, manifest);
    console.log(JSON.stringify({ mode: "apply", result }, null, 2));
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Ownership audit failed.");
    process.exitCode = 1;
  });
}

import { client } from "@mf-rag/db/client";
import { VectorClient } from "@mf-rag/vector";
import { createTenantAccessScope } from "@mf-rag/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredIds(name: string): readonly string[] {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required and must contain reviewed document UUIDs.`);
  const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`${name} must be a non-empty, duplicate-free comma-separated UUID list.`);
  }
  return ids;
}

const expected = {
  GLOBAL: requiredIds("ISOLATION_EXPECTED_GLOBAL_DOCUMENT_IDS"),
  "910": requiredIds("ISOLATION_EXPECTED_910_DOCUMENT_IDS"),
  "117": requiredIds("ISOLATION_EXPECTED_117_DOCUMENT_IDS"),
} as const;

type OwnershipRow = { document_id: string; visibility_scope: "GLOBAL" | "TENANT"; tenant_id: string | null; chunks: number };
const corpus = await client`
  SELECT document_id, visibility_scope, tenant_id, count(*)::integer AS chunks
  FROM (
    SELECT document_id, visibility_scope, tenant_id
    FROM chunks
    WHERE publication_status = 'published'
    UNION ALL
    SELECT generation.source_document_id AS document_id,
      chunk.visibility_scope, chunk.tenant_id
    FROM document_publication_chunks chunk
    JOIN document_publication_generations generation
      ON generation.id = chunk.generation_id
    WHERE generation.status = 'published'
  ) published
  WHERE visibility_scope IN ('GLOBAL', 'TENANT')
  GROUP BY document_id, visibility_scope, tenant_id
  ORDER BY document_id
` as OwnershipRow[];
const scheduledDocuments = await client`
  SELECT DISTINCT source_document_id AS document_id, tenant_id
  FROM document_publication_generations
  WHERE status = 'published' AND visibility_scope = 'TENANT'
    AND tenant_id IN ('910', '117')
` as Array<{ document_id: string; tenant_id: string }>;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function assertExact(label: string, actual: Iterable<string>, wanted: Iterable<string>): void {
  const actualIds = sorted(actual);
  const wantedIds = sorted(wanted);
  if (JSON.stringify(actualIds) !== JSON.stringify(wantedIds)) {
    throw new Error(`${label} mismatch: expected ${wantedIds.join(",")}; received ${actualIds.join(",")}.`);
  }
}

assertExact("GLOBAL inventory", corpus.filter((row) => row.visibility_scope === "GLOBAL").map((row) => row.document_id), expected.GLOBAL);
for (const code of ["910", "117"] as const) {
  assertExact(
    `${code} owned inventory`,
    corpus.filter((row) => row.visibility_scope === "TENANT" && row.tenant_id === code).map((row) => row.document_id),
    expected[code],
  );
  assertExact(
    `${code} scheduled-generation inventory`,
    scheduledDocuments.filter((row) => row.tenant_id === code).map((row) => row.document_id),
    expected[code],
  );
}
const unexpectedTenantRows = corpus.filter((row) => row.visibility_scope === "TENANT"
  && row.tenant_id !== "910" && row.tenant_id !== "117");
if (unexpectedTenantRows.length > 0) {
  throw new Error("Isolation evaluation corpus contains an undeclared tenant; refusing a partial proof.");
}

const vectorClient = new VectorClient();
const probeVector = new Array(1024).fill(0);
probeVector[0] = 1;
const checks: Array<Record<string, unknown>> = [];
for (const code of ["910", "117"] as const) {
  const accessScope = createTenantAccessScope(code);
  const visibleIds = new Set([...expected.GLOBAL, ...expected[code]]);
  const hiddenIds = expected[code === "910" ? "117" : "910"];
  const expectedChunkCount = corpus
    .filter((row) => visibleIds.has(row.document_id))
    .reduce((sum, row) => sum + row.chunks, 0);
  const info = await vectorClient.getCollectionInfo(accessScope);
  if (info.points_count !== expectedChunkCount) {
    throw new Error(`${code} count mismatch: expected ${expectedChunkCount}; received ${info.points_count}.`);
  }
  for (const documentId of visibleIds) {
    const rows = await vectorClient.searchSimilar(probeVector, {
      accessScope,
      filters: { document_id: documentId },
      limit: expectedChunkCount + 1,
    });
    if (rows.length === 0) throw new Error(`${code} cannot retrieve expected document ${documentId}.`);
  }
  for (const documentId of hiddenIds) {
    const rows = await vectorClient.searchSimilar(probeVector, {
      accessScope,
      filters: { document_id: documentId },
      limit: expectedChunkCount + 1,
    });
    if (rows.length > 0) throw new Error(`${code} leaked document ${documentId}.`);
  }
  checks.push({
    accessScope: code,
    expectedVisibleDocumentIds: sorted(visibleIds),
    expectedHiddenDocumentIds: sorted(hiddenIds),
    visibleChunkCount: info.points_count,
    directLookupAssertions: visibleIds.size + hiddenIds.length,
    passed: true,
  });
}

console.log(JSON.stringify({
  evaluatedAt: new Date().toISOString(),
  contract: "GLOBAL plus exact external access code; fail closed on undeclared inventory",
  checks,
}, null, 2));
await client.close();

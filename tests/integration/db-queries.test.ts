import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import * as schema from "../../packages/db/src/schema.ts";
import {
  createDocument,
  getDocumentById,
  getDocumentByHash,
  updateDocumentStatus,
  updateDocumentChunkCount,
  getDocumentsByStatus,
  getAllDocuments,
  createFund,
  getFundById,
  getFundByName,
  getAllFunds,
  linkDocumentToFund,
  unlinkDocumentFromFund,
  getDocumentFunds,
  getFundDocuments,
  deleteDocument,
  deleteFund,
} from "../../packages/db/src/queries.ts";
import type { NewDocument, NewFund } from "../../packages/db/src/schema.ts";

// Use Drizzle Database type with schema
type Database = BunSQLDatabase<typeof schema>;

// Test database URL - uses test database
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/mf_rag_test";

let client: SQL;
let db: Database;

// Sample test data
const sampleDocument: NewDocument = {
  filename: "test-fund-sid.pdf",
  filepath: "/data/pdfs/test-fund-sid.pdf",
  fileHash: "abc123def456789",
  docType: "SID",
  documentDate: new Date("2024-01-15"),
  pageCount: 50,
  status: "pending",
};

const sampleFund: NewFund = {
  name: "Test Flexi Cap Fund",
  amcName: "Test AMC",
  schemeType: "Equity",
  schemeCategory: "Flexi Cap",
  isinGrowth: "INF123456789",
  isinDividend: "INF987654321",
};

beforeAll(async () => {
  // Create test database connection
  client = new SQL(TEST_DATABASE_URL);
  db = drizzle({ client, schema });

  // Create tables if they don't exist (for test isolation)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      filename VARCHAR(255) NOT NULL,
      filepath VARCHAR(500) NOT NULL,
      file_hash VARCHAR(64) UNIQUE NOT NULL,
      doc_type VARCHAR(50),
      document_date DATE,
      page_count INTEGER,
      chunk_count INTEGER,
      status VARCHAR(20) DEFAULT 'pending' NOT NULL,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS funds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      amc_name VARCHAR(255),
      scheme_type VARCHAR(50),
      scheme_category VARCHAR(100),
      isin_growth VARCHAR(20),
      isin_dividend VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS document_funds (
      document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, fund_id)
    )
  `);
});

afterAll(async () => {
  // Cleanup test data
  await db.execute(sql`DELETE FROM document_funds`);
  await db.execute(sql`DELETE FROM funds`);
  await db.execute(sql`DELETE FROM documents`);
  await client.close();
});

beforeEach(async () => {
  // Clean up between tests
  await db.execute(sql`DELETE FROM document_funds`);
  await db.execute(sql`DELETE FROM funds`);
  await db.execute(sql`DELETE FROM documents`);
});

describe("Document Operations", () => {
  test("createDocument should insert a new document and return it", async () => {
    const doc = await createDocument(db, sampleDocument);

    expect(doc).toBeDefined();
    expect(doc.id).toBeDefined();
    expect(doc.filename).toBe(sampleDocument.filename);
    expect(doc.filepath).toBe(sampleDocument.filepath);
    expect(doc.fileHash).toBe(sampleDocument.fileHash);
    expect(doc.docType ?? null).toBe(sampleDocument.docType ?? null);
    expect(doc.pageCount ?? null).toBe(sampleDocument.pageCount ?? null);
    expect(doc.status).toBe("pending");
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  test("createDocument should fail with duplicate file hash", async () => {
    await createDocument(db, sampleDocument);

    await expect(createDocument(db, sampleDocument)).rejects.toThrow();
  });

  test("getDocumentById should return the document if it exists", async () => {
    const created = await createDocument(db, sampleDocument);
    const found = await getDocumentById(db, created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.filename).toBe(sampleDocument.filename);
  });

  test("getDocumentById should return undefined for non-existent id", async () => {
    const found = await getDocumentById(db, "00000000-0000-0000-0000-000000000000");
    expect(found).toBeUndefined();
  });

  test("getDocumentByHash should return the document if it exists", async () => {
    const created = await createDocument(db, sampleDocument);
    const found = await getDocumentByHash(db, sampleDocument.fileHash);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.fileHash).toBe(sampleDocument.fileHash);
  });

  test("getDocumentByHash should return undefined for non-existent hash", async () => {
    const found = await getDocumentByHash(db, "nonexistenthash");
    expect(found).toBeUndefined();
  });

  test("updateDocumentStatus should update status and updatedAt", async () => {
    const created = await createDocument(db, sampleDocument);
    const initialUpdatedAt = created.updatedAt;

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await updateDocumentStatus(db, created.id, "processing");

    expect(updated).toBeDefined();
    expect(updated?.status).toBe("processing");
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      initialUpdatedAt.getTime()
    );
  });

  test("updateDocumentStatus should set error message when provided", async () => {
    const created = await createDocument(db, sampleDocument);
    const errorMsg = "Failed to parse PDF";

    const updated = await updateDocumentStatus(db, created.id, "failed", errorMsg);

    expect(updated).toBeDefined();
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toBe(errorMsg);
  });

  test("updateDocumentChunkCount should update chunk count", async () => {
    const created = await createDocument(db, sampleDocument);
    const updated = await updateDocumentChunkCount(db, created.id, 25);

    expect(updated).toBeDefined();
    expect(updated?.chunkCount).toBe(25);
  });

  test("getDocumentsByStatus should return documents with matching status", async () => {
    await createDocument(db, { ...sampleDocument, fileHash: "hash1", status: "pending" });
    await createDocument(db, { ...sampleDocument, fileHash: "hash2", status: "completed" });
    await createDocument(db, { ...sampleDocument, fileHash: "hash3", status: "pending" });

    const pending = await getDocumentsByStatus(db, "pending");
    expect(pending).toHaveLength(2);

    const completed = await getDocumentsByStatus(db, "completed");
    expect(completed).toHaveLength(1);
  });

  test("getAllDocuments should return all documents", async () => {
    await createDocument(db, { ...sampleDocument, fileHash: "hash1" });
    await createDocument(db, { ...sampleDocument, fileHash: "hash2" });
    await createDocument(db, { ...sampleDocument, fileHash: "hash3" });

    const docs = await getAllDocuments(db);
    expect(docs).toHaveLength(3);
  });

  test("deleteDocument should remove the document", async () => {
    const created = await createDocument(db, sampleDocument);
    await deleteDocument(db, created.id);

    const found = await getDocumentById(db, created.id);
    expect(found).toBeUndefined();
  });
});

describe("Fund Operations", () => {
  test("createFund should insert a new fund and return it", async () => {
    const fund = await createFund(db, sampleFund);

    expect(fund).toBeDefined();
    expect(fund.id).toBeDefined();
    expect(fund.name).toBe(sampleFund.name);
    expect(fund.amcName ?? null).toBe(sampleFund.amcName ?? null);
    expect(fund.schemeType ?? null).toBe(sampleFund.schemeType ?? null);
    expect(fund.schemeCategory ?? null).toBe(sampleFund.schemeCategory ?? null);
    expect(fund.isinGrowth ?? null).toBe(sampleFund.isinGrowth ?? null);
    expect(fund.isinDividend ?? null).toBe(sampleFund.isinDividend ?? null);
    expect(fund.createdAt).toBeInstanceOf(Date);
  });

  test("getFundById should return the fund if it exists", async () => {
    const created = await createFund(db, sampleFund);
    const found = await getFundById(db, created.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe(sampleFund.name);
  });

  test("getFundById should return undefined for non-existent id", async () => {
    const found = await getFundById(db, "00000000-0000-0000-0000-000000000000");
    expect(found).toBeUndefined();
  });

  test("getFundByName should return the fund if it exists", async () => {
    const created = await createFund(db, sampleFund);
    const found = await getFundByName(db, sampleFund.name);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
  });

  test("getFundByName should return undefined for non-existent name", async () => {
    const found = await getFundByName(db, "Non-existent Fund");
    expect(found).toBeUndefined();
  });

  test("getAllFunds should return all funds", async () => {
    await createFund(db, { ...sampleFund, name: "Fund 1" });
    await createFund(db, { ...sampleFund, name: "Fund 2" });

    const funds = await getAllFunds(db);
    expect(funds).toHaveLength(2);
  });

  test("deleteFund should remove the fund", async () => {
    const created = await createFund(db, sampleFund);
    await deleteFund(db, created.id);

    const found = await getFundById(db, created.id);
    expect(found).toBeUndefined();
  });
});

describe("Document-Fund Link Operations", () => {
  test("linkDocumentToFund should create a link between document and fund", async () => {
    const doc = await createDocument(db, sampleDocument);
    const fund = await createFund(db, sampleFund);

    await linkDocumentToFund(db, doc.id, fund.id);

    const linkedFunds = await getDocumentFunds(db, doc.id);
    expect(linkedFunds).toHaveLength(1);
    expect(linkedFunds[0]?.id).toBe(fund.id);
  });

  test("linkDocumentToFund should not create duplicate links", async () => {
    const doc = await createDocument(db, sampleDocument);
    const fund = await createFund(db, sampleFund);

    await linkDocumentToFund(db, doc.id, fund.id);
    await linkDocumentToFund(db, doc.id, fund.id); // Should not throw

    const linkedFunds = await getDocumentFunds(db, doc.id);
    expect(linkedFunds).toHaveLength(1);
  });

  test("unlinkDocumentFromFund should remove the link", async () => {
    const doc = await createDocument(db, sampleDocument);
    const fund = await createFund(db, sampleFund);

    await linkDocumentToFund(db, doc.id, fund.id);
    await unlinkDocumentFromFund(db, doc.id, fund.id);

    const linkedFunds = await getDocumentFunds(db, doc.id);
    expect(linkedFunds).toHaveLength(0);
  });

  test("getDocumentFunds should return all funds linked to a document", async () => {
    const doc = await createDocument(db, sampleDocument);
    const fund1 = await createFund(db, { ...sampleFund, name: "Fund 1" });
    const fund2 = await createFund(db, { ...sampleFund, name: "Fund 2" });

    await linkDocumentToFund(db, doc.id, fund1.id);
    await linkDocumentToFund(db, doc.id, fund2.id);

    const linkedFunds = await getDocumentFunds(db, doc.id);
    expect(linkedFunds).toHaveLength(2);
    expect(linkedFunds.map((f) => f.name).sort()).toEqual(["Fund 1", "Fund 2"]);
  });

  test("getFundDocuments should return all documents linked to a fund", async () => {
    const fund = await createFund(db, sampleFund);
    const doc1 = await createDocument(db, { ...sampleDocument, fileHash: "hash1" });
    const doc2 = await createDocument(db, { ...sampleDocument, fileHash: "hash2" });

    await linkDocumentToFund(db, doc1.id, fund.id);
    await linkDocumentToFund(db, doc2.id, fund.id);

    const linkedDocs = await getFundDocuments(db, fund.id);
    expect(linkedDocs).toHaveLength(2);
  });

  test("deleting a document should cascade delete links", async () => {
    const doc = await createDocument(db, sampleDocument);
    const fund = await createFund(db, sampleFund);

    await linkDocumentToFund(db, doc.id, fund.id);
    await deleteDocument(db, doc.id);

    // Fund should still exist
    const foundFund = await getFundById(db, fund.id);
    expect(foundFund).toBeDefined();

    // But no linked documents
    const linkedDocs = await getFundDocuments(db, fund.id);
    expect(linkedDocs).toHaveLength(0);
  });

  test("deleting a fund should cascade delete links", async () => {
    const doc = await createDocument(db, sampleDocument);
    const fund = await createFund(db, sampleFund);

    await linkDocumentToFund(db, doc.id, fund.id);
    await deleteFund(db, fund.id);

    // Document should still exist
    const foundDoc = await getDocumentById(db, doc.id);
    expect(foundDoc).toBeDefined();

    // But no linked funds
    const linkedFunds = await getDocumentFunds(db, doc.id);
    expect(linkedFunds).toHaveLength(0);
  });
});

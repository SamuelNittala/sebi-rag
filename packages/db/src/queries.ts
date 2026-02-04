import { eq, and } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  documents,
  funds,
  documentFunds,
  type NewDocument,
  type NewFund,
  type Document,
  type Fund,
  type DocumentStatus,
} from "./schema.ts";

/**
 * Query helper functions for database operations.
 * All functions accept a database instance to enable testing with transactions.
 */

// Document operations

export async function createDocument(
  db: Database,
  data: NewDocument
): Promise<Document> {
  const [doc] = await db.insert(documents).values(data).returning();
  if (!doc) {
    throw new Error("Failed to create document");
  }
  return doc;
}

export async function getDocumentById(
  db: Database,
  id: string
): Promise<Document | undefined> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, id));
  return doc;
}

export async function getDocumentByHash(
  db: Database,
  fileHash: string
): Promise<Document | undefined> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.fileHash, fileHash));
  return doc;
}

export async function updateDocumentStatus(
  db: Database,
  id: string,
  status: DocumentStatus,
  errorMessage?: string
): Promise<Document | undefined> {
  const updateData: Partial<Document> = {
    status,
    updatedAt: new Date(),
  };

  if (errorMessage !== undefined) {
    updateData.errorMessage = errorMessage;
  }

  const [doc] = await db
    .update(documents)
    .set(updateData)
    .where(eq(documents.id, id))
    .returning();

  return doc;
}

export async function updateDocumentChunkCount(
  db: Database,
  id: string,
  chunkCount: number
): Promise<Document | undefined> {
  const [doc] = await db
    .update(documents)
    .set({ chunkCount, updatedAt: new Date() })
    .where(eq(documents.id, id))
    .returning();

  return doc;
}

export async function getDocumentsByStatus(
  db: Database,
  status: DocumentStatus
): Promise<Document[]> {
  return db.select().from(documents).where(eq(documents.status, status));
}

export async function getAllDocuments(db: Database): Promise<Document[]> {
  return db.select().from(documents);
}

// Fund operations

export async function createFund(db: Database, data: NewFund): Promise<Fund> {
  const [fund] = await db.insert(funds).values(data).returning();
  if (!fund) {
    throw new Error("Failed to create fund");
  }
  return fund;
}

export async function getFundById(
  db: Database,
  id: string
): Promise<Fund | undefined> {
  const [fund] = await db.select().from(funds).where(eq(funds.id, id));
  return fund;
}

export async function getFundByName(
  db: Database,
  name: string
): Promise<Fund | undefined> {
  const [fund] = await db.select().from(funds).where(eq(funds.name, name));
  return fund;
}

export async function getAllFunds(db: Database): Promise<Fund[]> {
  return db.select().from(funds);
}

export async function getFundBySebiSchemeId(
  db: Database,
  sebiSchemeId: string
): Promise<Fund | undefined> {
  const [fund] = await db
    .select()
    .from(funds)
    .where(eq(funds.sebiSchemeId, sebiSchemeId));
  return fund;
}

// Document-Fund link operations

export async function linkDocumentToFund(
  db: Database,
  documentId: string,
  fundId: string
): Promise<void> {
  await db.insert(documentFunds).values({ documentId, fundId }).onConflictDoNothing();
}

export async function unlinkDocumentFromFund(
  db: Database,
  documentId: string,
  fundId: string
): Promise<void> {
  await db
    .delete(documentFunds)
    .where(
      and(
        eq(documentFunds.documentId, documentId),
        eq(documentFunds.fundId, fundId)
      )
    );
}

export async function getDocumentFunds(
  db: Database,
  documentId: string
): Promise<Fund[]> {
  const results = await db
    .select({ fund: funds })
    .from(documentFunds)
    .innerJoin(funds, eq(documentFunds.fundId, funds.id))
    .where(eq(documentFunds.documentId, documentId));

  return results.map((r) => r.fund);
}

export async function getFundDocuments(
  db: Database,
  fundId: string
): Promise<Document[]> {
  const results = await db
    .select({ document: documents })
    .from(documentFunds)
    .innerJoin(documents, eq(documentFunds.documentId, documents.id))
    .where(eq(documentFunds.fundId, fundId));

  return results.map((r) => r.document);
}

// Utility operations

export async function deleteDocument(db: Database, id: string): Promise<void> {
  await db.delete(documents).where(eq(documents.id, id));
}

export async function deleteFund(db: Database, id: string): Promise<void> {
  await db.delete(funds).where(eq(funds.id, id));
}

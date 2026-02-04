export interface Document {
  id: string;
  filename: string;
  filepath: string;
  fileHash: string;
  docType?: string;
  documentDate?: Date;
  pageCount?: number;
  chunkCount?: number;
  status: "pending" | "processing" | "completed" | "failed";
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Asset Management Company
 */
export interface AMC {
  id: string;
  sebiId: string;
  name: string;
  createdAt: Date;
}

export interface Fund {
  id: string;
  name: string;
  amcName?: string;
  schemeType?: string;
  schemeCategory?: string;
  isinGrowth?: string;
  isinDividend?: string;
  // SEBI identifiers
  sebiSchemeId?: string;
  sebiFundId?: string;
  amcId?: string;
  createdAt: Date;
}

export interface DocumentFund {
  documentId: string;
  fundId: string;
}

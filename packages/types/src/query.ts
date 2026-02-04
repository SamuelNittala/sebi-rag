export interface QueryFilters {
  fundName?: string;
  amcName?: string;
  schemeType?: "Equity" | "Debt" | "Hybrid" | "Solution" | "Other";
  docType?: "SID" | "KIM" | "Factsheet" | "AnnualReport";
  dateFrom?: string;
  dateTo?: string;
}

export interface QueryRequest {
  query: string;
  filters?: QueryFilters;
  limit?: number;
}

export interface SearchRequest {
  query: string;
  filters?: QueryFilters;
  limit?: number;
}

export interface IngestRequest {
  path: string;
}

/**
 * Metadata extraction module
 *
 * Extracts metadata from mutual fund documents for FILTERING during retrieval.
 * All content gets indexed regardless - metadata enables filtering.
 */

export {
  extractMetadata,
  type ExtractedMetadata,
  type MetadataInput,
  type DocType,
  type SchemeType,
} from "./extractor";

export * from "./knowledge-scope.ts";

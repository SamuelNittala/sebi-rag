/**
 * Docling parse wire contract, version 1.
 *
 * TypeScript mirror of python/docling_service/contract/docling-parse-v1.schema.json
 * (the normative schema) plus the cross-field rules JSON Schema cannot express.
 * Every response body from the Docling service is checked by
 * assertDoclingParseResponse before anything downstream reads it.
 */

export const DOCLING_PARSE_MEDIA_TYPE = "application/vnd.mf-rag.docling-parse+json;version=1";

export const DOCLING_CHUNK_TYPES = ["text", "table", "picture", "key_value"] as const;
export type DoclingChunkType = (typeof DOCLING_CHUNK_TYPES)[number];

export const DOCLING_NORMALIZATION_FLAGS = [
  "ordinal_joined",
  "kv_lines_joined",
  "table_span_collapsed",
  "kv_panel_detected",
  "table_header_promoted",
  "heading_from_table_title",
  "table_rows_split",
  "picture_text_recovered",
  "riskometer_text_extracted",
  "chart_pairs_extracted",
  "chart_multi_series_unparsed",
  "chart_unpaired",
  "mixed_chunk_split",
] as const;
export type DoclingNormalizationFlag = (typeof DOCLING_NORMALIZATION_FLAGS)[number];

/** Flags each chunk type may carry. */
export const DOCLING_FLAGS_BY_CHUNK_TYPE: Readonly<Record<DoclingChunkType, readonly DoclingNormalizationFlag[]>> = {
  text: ["ordinal_joined", "kv_lines_joined", "mixed_chunk_split"],
  table: [
    "ordinal_joined",
    "mixed_chunk_split",
    "table_span_collapsed",
    "table_header_promoted",
    "heading_from_table_title",
    "table_rows_split",
  ],
  key_value: [
    "ordinal_joined",
    "mixed_chunk_split",
    "table_span_collapsed",
    "kv_panel_detected",
    "heading_from_table_title",
    "table_rows_split",
  ],
  picture: [
    "ordinal_joined",
    "picture_text_recovered",
    "riskometer_text_extracted",
    "chart_pairs_extracted",
    "chart_multi_series_unparsed",
    "chart_unpaired",
  ],
};

/** A picture chunk carries at most one of these outcomes. */
export const DOCLING_PICTURE_OUTCOME_FLAGS: readonly DoclingNormalizationFlag[] = [
  "riskometer_text_extracted",
  "chart_pairs_extracted",
  "chart_multi_series_unparsed",
  "chart_unpaired",
];

const REQUIRED_FLAG_BY_CHUNK_TYPE: Readonly<Partial<Record<DoclingChunkType, DoclingNormalizationFlag>>> = {
  picture: "picture_text_recovered",
  key_value: "kv_panel_detected",
};

export interface DoclingProducer {
  /** `docling-<doclingVersion>+norm-<normalizerVersion>+opts-<pipelineOptionsSha256[0:12]>` */
  readonly parserVersion: string;
  readonly serviceVersion: string;
  readonly doclingVersion: string;
  readonly doclingCoreVersion: string;
  readonly doclingIbmModelsVersion: string;
  readonly normalizerVersion: string;
  readonly pipelineOptionsSha256: string;
}

export interface DoclingPageStats {
  readonly textItems: number;
  readonly tables: number;
  readonly pictures: number;
  readonly pictureTextChars: number;
  readonly bodyTextChars: number;
}

export interface DoclingWirePage {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
  /** Reading-order text including picture text and table rows; may be empty. */
  readonly text: string;
  /** Equals `stats.tables > 0`. */
  readonly hasTable: boolean;
  readonly stats: DoclingPageStats;
}

/** Docling BOTTOMLEFT points, normalized so `l < r` and `b < t`. */
export interface DoclingBoundingBox {
  readonly page: number;
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

export interface DoclingPictureInfo {
  /** Top DocumentFigureClassifier class, e.g. `bar_chart`, `pie_chart`. */
  readonly classification: string;
  readonly confidence: number;
  /** Label/value pairs emitted; > 0 exactly when `chart_pairs_extracted` is set. */
  readonly pairCount: number;
}

export interface DoclingWireChunk {
  /** Contiguous from 0 in body reading order. */
  readonly chunkIndex: number;
  readonly type: DoclingChunkType;
  /** Non-empty, trimmed, no U+0000, no line equal to one of `headings`. */
  readonly text: string;
  readonly headings: readonly string[];
  /** Non-empty, strictly ascending, each within `1..pageCount`. */
  readonly pages: readonly number[];
  readonly bboxes: readonly DoclingBoundingBox[];
  /** DoclingDocument JSON pointers, e.g. `#/tables/0`. */
  readonly itemRefs: readonly string[];
  readonly flags: readonly DoclingNormalizationFlag[];
  /** Non-null exactly for `type: "picture"`. */
  readonly picture: DoclingPictureInfo | null;
}

export interface DoclingDroppedPictures {
  readonly logo: number;
  readonly signature: number;
  readonly stamp: number;
  readonly qrCode: number;
  readonly barCode: number;
  readonly noText: number;
}

export interface DoclingParseDiagnostics {
  readonly droppedPictures: DoclingDroppedPictures;
  /** Number of chunks carrying each flag; zero counts are omitted. */
  readonly flagCounts: Readonly<Partial<Record<DoclingNormalizationFlag, number>>>;
  readonly conversionStatus: "success";
  readonly conversionMs: number;
}

export interface DoclingParseResponse {
  readonly schemaVersion: 1;
  readonly producer: DoclingProducer;
  readonly source: { readonly sha256: string; readonly byteSize: number };
  readonly pageCount: number;
  readonly pages: readonly DoclingWirePage[];
  readonly chunks: readonly DoclingWireChunk[];
  readonly diagnostics: DoclingParseDiagnostics;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NORMALIZER_VERSION_PATTERN = /^[1-9]\d*$/;
const PARSER_VERSION_PATTERN = /^docling-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\+norm-([1-9]\d*)\+opts-([0-9a-f]{12})$/;
const ITEM_REF_PATTERN = /^#\/(texts|tables|pictures|key_value_items|form_items)\/(0|[1-9]\d*)$/;
const PICTURE_CLASS_PATTERN = /^[a-z][a-z0-9_]*$/;
const DROPPED_PICTURE_KEYS = ["logo", "signature", "stamp", "qrCode", "barCode", "noText"] as const;

const ROOT_KEYS = ["schemaVersion", "producer", "source", "pageCount", "pages", "chunks", "diagnostics"];
const PRODUCER_KEYS = [
  "parserVersion",
  "serviceVersion",
  "doclingVersion",
  "doclingCoreVersion",
  "doclingIbmModelsVersion",
  "normalizerVersion",
  "pipelineOptionsSha256",
];
const PAGE_KEYS = ["pageNumber", "width", "height", "text", "hasTable", "stats"];
const STATS_KEYS = ["textItems", "tables", "pictures", "pictureTextChars", "bodyTextChars"];
const CHUNK_KEYS = ["chunkIndex", "type", "text", "headings", "pages", "bboxes", "itemRefs", "flags", "picture"];
const BBOX_KEYS = ["page", "l", "t", "r", "b"];
const PICTURE_KEYS = ["classification", "confidence", "pairCount"];
const DIAGNOSTICS_KEYS = ["droppedPictures", "flagCounts", "conversionStatus", "conversionMs"];

/**
 * Throws a deterministic `INVALID_DOCLING_RESPONSE` error naming the first
 * offending field path. Never echoes field values.
 */
export function assertDoclingParseResponse(value: unknown): asserts value is DoclingParseResponse {
  const root = expectExactObject(value, "response", ROOT_KEYS);
  if (root.schemaVersion !== 1) fail("schemaVersion", "must be 1");
  assertProducer(root.producer);

  const source = expectExactObject(root.source, "source", ["sha256", "byteSize"]);
  if (!isString(source.sha256) || !SHA256_PATTERN.test(source.sha256)) fail("source.sha256", "must be 64 lowercase hex characters");
  if (!isPositiveInteger(source.byteSize)) fail("source.byteSize", "must be a positive integer");

  if (!isPositiveInteger(root.pageCount)) fail("pageCount", "must be a positive integer");
  const pageCount = root.pageCount;
  const pages = expectArray(root.pages, "pages");
  if (pages.length !== pageCount) fail("pages", "length must equal pageCount");
  pages.forEach((page, index) => assertPage(page, index));

  assertDoclingWireChunks(root.chunks, pageCount);
  assertDiagnostics(root.diagnostics, root.chunks);
}

/**
 * Per-chunk rules of the wire contract, reused to validate stored parse
 * artifacts. Throws `INVALID_DOCLING_RESPONSE` naming the field path.
 */
export function assertDoclingWireChunks(value: unknown, pageCount: number): asserts value is DoclingWireChunk[] {
  const chunks = expectArray(value, "chunks");
  if (chunks.length === 0) fail("chunks", "must not be empty");
  chunks.forEach((chunk, index) => assertChunk(chunk, index, pageCount));
}

export function assertDoclingPageStats(value: unknown, path: string): asserts value is DoclingPageStats {
  const stats = expectExactObject(value, path, STATS_KEYS);
  for (const key of STATS_KEYS) {
    if (!isCount(stats[key])) fail(`${path}.${key}`, "must be a non-negative integer");
  }
}

export function assertDoclingDroppedPictures(value: unknown, path: string): asserts value is DoclingDroppedPictures {
  const dropped = expectExactObject(value, path, [...DROPPED_PICTURE_KEYS]);
  for (const key of DROPPED_PICTURE_KEYS) {
    if (!isCount(dropped[key])) fail(`${path}.${key}`, "must be a non-negative integer");
  }
}

/** Flag counts as the contract defines them: chunks carrying each flag, zero counts omitted. */
export function countDoclingFlags(
  chunks: readonly DoclingWireChunk[],
): Partial<Record<DoclingNormalizationFlag, number>> {
  const counts: Partial<Record<DoclingNormalizationFlag, number>> = {};
  for (const chunk of chunks) {
    for (const flag of chunk.flags) counts[flag] = (counts[flag] ?? 0) + 1;
  }
  return counts;
}

function assertProducer(value: unknown): void {
  const producer = expectExactObject(value, "producer", PRODUCER_KEYS);
  for (const key of ["serviceVersion", "doclingVersion", "doclingCoreVersion", "doclingIbmModelsVersion"]) {
    const field = producer[key];
    if (!isString(field) || !SEMVER_PATTERN.test(field)) fail(`producer.${key}`, "must be a MAJOR.MINOR.PATCH version");
  }
  if (!isString(producer.normalizerVersion) || !NORMALIZER_VERSION_PATTERN.test(producer.normalizerVersion)) {
    fail("producer.normalizerVersion", "must be a positive integer string");
  }
  if (!isString(producer.pipelineOptionsSha256) || !SHA256_PATTERN.test(producer.pipelineOptionsSha256)) {
    fail("producer.pipelineOptionsSha256", "must be 64 lowercase hex characters");
  }
  const match = isString(producer.parserVersion) ? PARSER_VERSION_PATTERN.exec(producer.parserVersion) : null;
  if (!match) fail("producer.parserVersion", "must match docling-<version>+norm-<n>+opts-<12 hex>");
  if (match[1] !== producer.doclingVersion
    || match[2] !== producer.normalizerVersion
    || match[3] !== producer.pipelineOptionsSha256.slice(0, 12)) {
    fail("producer.parserVersion", "must embed doclingVersion, normalizerVersion and the pipelineOptionsSha256 prefix");
  }
}

function assertPage(value: unknown, index: number): void {
  const path = `pages[${index}]`;
  const page = expectExactObject(value, path, PAGE_KEYS);
  if (page.pageNumber !== index + 1) fail(`${path}.pageNumber`, "must equal its position + 1");
  if (!isPositiveNumber(page.width)) fail(`${path}.width`, "must be a positive number");
  if (!isPositiveNumber(page.height)) fail(`${path}.height`, "must be a positive number");
  if (!isString(page.text) || page.text.includes("\u0000")) fail(`${path}.text`, "must be a string without U+0000");
  if (typeof page.hasTable !== "boolean") fail(`${path}.hasTable`, "must be a boolean");
  assertDoclingPageStats(page.stats, `${path}.stats`);
  if (page.hasTable !== page.stats.tables > 0) fail(`${path}.hasTable`, "must equal stats.tables > 0");
}

function assertChunk(value: unknown, index: number, pageCount: number): void {
  const path = `chunks[${index}]`;
  const chunk = expectExactObject(value, path, CHUNK_KEYS);
  if (chunk.chunkIndex !== index) fail(`${path}.chunkIndex`, "must be contiguous from 0");
  if (!isString(chunk.type) || !(DOCLING_CHUNK_TYPES as readonly string[]).includes(chunk.type)) {
    fail(`${path}.type`, `must be one of ${DOCLING_CHUNK_TYPES.join(", ")}`);
  }
  const type = chunk.type as DoclingChunkType;

  const headings = expectArray(chunk.headings, `${path}.headings`);
  headings.forEach((heading, headingIndex) => {
    if (!isCleanText(heading) || /[\r\n]/.test(heading)) {
      fail(`${path}.headings[${headingIndex}]`, "must be a non-empty, trimmed, single-line string without U+0000");
    }
  });
  if (!isCleanText(chunk.text)) fail(`${path}.text`, "must be non-empty, trimmed and free of U+0000");
  const headingSet = new Set(headings as string[]);
  if (chunk.text.split("\n").some((line) => headingSet.has(line.trim()))) {
    fail(`${path}.text`, "must not repeat a heading line");
  }

  const pages = expectArray(chunk.pages, `${path}.pages`);
  if (pages.length === 0) fail(`${path}.pages`, "must not be empty");
  pages.forEach((page, pageIndex) => {
    if (!isPositiveInteger(page) || page > pageCount) fail(`${path}.pages[${pageIndex}]`, "must be within 1..pageCount");
    if (pageIndex > 0 && page <= (pages[pageIndex - 1] as number)) fail(`${path}.pages`, "must be strictly ascending");
  });

  const bboxes = expectArray(chunk.bboxes, `${path}.bboxes`);
  if (bboxes.length === 0) fail(`${path}.bboxes`, "must not be empty");
  bboxes.forEach((bbox, bboxIndex) => assertBoundingBox(bbox, `${path}.bboxes[${bboxIndex}]`, pages as number[]));

  const itemRefs = expectArray(chunk.itemRefs, `${path}.itemRefs`);
  if (itemRefs.length === 0) fail(`${path}.itemRefs`, "must not be empty");
  itemRefs.forEach((ref, refIndex) => {
    if (!isString(ref) || !ITEM_REF_PATTERN.test(ref)) fail(`${path}.itemRefs[${refIndex}]`, "must be a DoclingDocument item pointer");
  });
  if (new Set(itemRefs).size !== itemRefs.length) fail(`${path}.itemRefs`, "must be unique");

  const flags = assertChunkFlags(chunk.flags, `${path}.flags`, type);
  assertChunkPicture(chunk.picture, `${path}.picture`, type, flags);
}

function assertBoundingBox(value: unknown, path: string, chunkPages: readonly number[]): void {
  const bbox = expectExactObject(value, path, BBOX_KEYS);
  if (!isPositiveInteger(bbox.page) || !chunkPages.includes(bbox.page)) fail(`${path}.page`, "must be one of the chunk pages");
  for (const key of ["l", "t", "r", "b"]) {
    if (!isFiniteNumber(bbox[key])) fail(`${path}.${key}`, "must be a finite number");
  }
  if ((bbox.l as number) >= (bbox.r as number)) fail(path, "must satisfy l < r");
  if ((bbox.b as number) >= (bbox.t as number)) fail(path, "must satisfy b < t (BOTTOMLEFT origin)");
}

function assertChunkFlags(value: unknown, path: string, type: DoclingChunkType): readonly DoclingNormalizationFlag[] {
  const flags = expectArray(value, path);
  const allowed = DOCLING_FLAGS_BY_CHUNK_TYPE[type] as readonly unknown[];
  flags.forEach((flag, flagIndex) => {
    if (!isString(flag) || !(DOCLING_NORMALIZATION_FLAGS as readonly string[]).includes(flag)) {
      fail(`${path}[${flagIndex}]`, "is not a known normalization flag");
    }
    if (!allowed.includes(flag)) fail(`${path}[${flagIndex}]`, `is not allowed on ${type} chunks`);
  });
  if (new Set(flags).size !== flags.length) fail(path, "must be unique");
  const required = REQUIRED_FLAG_BY_CHUNK_TYPE[type];
  if (required && !flags.includes(required)) fail(path, `must include ${required} on ${type} chunks`);
  if (flags.filter((flag) => DOCLING_PICTURE_OUTCOME_FLAGS.includes(flag as DoclingNormalizationFlag)).length > 1) {
    fail(path, "must contain at most one picture outcome flag");
  }
  return flags as DoclingNormalizationFlag[];
}

function assertChunkPicture(
  value: unknown,
  path: string,
  type: DoclingChunkType,
  flags: readonly DoclingNormalizationFlag[],
): void {
  if (type !== "picture") {
    if (value !== null) fail(path, "must be null unless type is picture");
    return;
  }
  const picture = expectExactObject(value, path, PICTURE_KEYS);
  if (!isString(picture.classification) || !PICTURE_CLASS_PATTERN.test(picture.classification)) {
    fail(`${path}.classification`, "must be a classifier class name");
  }
  if (!isFiniteNumber(picture.confidence) || picture.confidence < 0 || picture.confidence > 1) {
    fail(`${path}.confidence`, "must be within 0..1");
  }
  if (!isCount(picture.pairCount)) fail(`${path}.pairCount`, "must be a non-negative integer");
  if ((picture.pairCount > 0) !== flags.includes("chart_pairs_extracted")) {
    fail(`${path}.pairCount`, "must be positive exactly when chart_pairs_extracted is set");
  }
}

function assertDiagnostics(value: unknown, chunks: readonly DoclingWireChunk[]): void {
  const diagnostics = expectExactObject(value, "diagnostics", DIAGNOSTICS_KEYS);
  assertDoclingDroppedPictures(diagnostics.droppedPictures, "diagnostics.droppedPictures");
  if (diagnostics.conversionStatus !== "success") fail("diagnostics.conversionStatus", "must be success");
  if (!isCount(diagnostics.conversionMs)) fail("diagnostics.conversionMs", "must be a non-negative integer");

  const flagCounts = expectObject(diagnostics.flagCounts, "diagnostics.flagCounts");
  const expected = new Map<string, number>(Object.entries(countDoclingFlags(chunks)));
  for (const [flag, count] of Object.entries(flagCounts)) {
    if (!(DOCLING_NORMALIZATION_FLAGS as readonly string[]).includes(flag)) {
      fail("diagnostics.flagCounts", "contains an unknown normalization flag");
    }
    if (count !== expected.get(flag)) fail(`diagnostics.flagCounts.${flag}`, "must equal the number of chunks carrying the flag");
  }
  if (Object.keys(flagCounts).length !== expected.size) {
    fail("diagnostics.flagCounts", "must list every flag carried by a chunk");
  }
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function expectExactObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  const object = expectObject(value, path);
  const actual = Object.keys(object);
  const unknownKey = actual.find((key) => !keys.includes(key));
  if (unknownKey !== undefined) fail(path, "contains an unknown property");
  const missingKey = keys.find((key) => !Object.hasOwn(object, key));
  if (missingKey !== undefined) fail(`${path}.${missingKey}`, "is required");
  return object;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCleanText(value: unknown): value is string {
  return isString(value) && value.length > 0 && value === value.trim() && !value.includes("\u0000");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function fail(path: string, message: string): never {
  throw Object.assign(new Error(`Docling parse response ${path} ${message}.`), {
    code: "INVALID_DOCLING_RESPONSE",
    classification: "deterministic" as const,
  });
}

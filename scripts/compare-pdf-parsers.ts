/**
 * Shadow comparison of the unpdf and Docling PDF parse paths (no database).
 *
 *   bun run parse:compare -- --pdf <file.pdf> [--pdf <file.pdf> ...]
 *     [--scope config/access-scopes/117-mirae-mf.yml]
 *     [--docling-url http://localhost:8090] [--docling-version <parserVersion>]
 *     [--pages FIRST-LAST] [--out <dir>]
 *
 * Each PDF goes through `ParsePdfStage` (unpdf + pdfplumber tables) and
 * `DoclingParseStage` (HTTP client against a running service) with an
 * in-memory artifact store, then `preparePdfChunkInspection` with the scope's
 * classification and a synthetic tenant ownership. Writes `report.json` and
 * `report.md` to `--out` (default `$TMPDIR/mf-rag-parse-compare/<timestamp>`;
 * never inside `data/`) and prints the summary table.
 *
 * `--pages`: no TypeScript dependency here can write a PDF slice (unpdf only
 * reads), so both parsers process the whole file and their artifacts are
 * restricted to the range before chunking (`restrictArtifactToPages`). Docling
 * still converts every page, so a range does not save Docling time.
 *
 * `--docling-version` defaults to the service's `/health` parserVersion.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import type { ArtifactDescriptor, ClassifiedKnowledgeOwnership, KnowledgeScope } from "@mf-rag/types";

import { parseAccessScopeManifestYaml } from "../apps/pipeline/src/config/access-scope-manifest.ts";
import { fetchDoclingHealth } from "../apps/ingestion/src/parsers/docling-client.ts";
import { preparePdfChunkInspection, type PdfParseArtifact } from "../apps/ingestion/src/stages/chunk-inspect-stage.ts";
import { DoclingParseStage } from "../apps/ingestion/src/stages/docling-parse-stage.ts";
import { ParsePdfStage, type PdfStageArtifactStore } from "../apps/ingestion/src/stages/parse-pdf-stage.ts";
import {
  compareParserInspections,
  parsePageRange,
  renderComparisonMarkdown,
  restrictArtifactToPages,
  type ComparisonSideInput,
  type PageRange,
  type ParserComparison,
} from "../apps/ingestion/src/stages/parser-comparison.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const UNPDF_PARSER_VERSION = "unpdf-local";
const UNPDF_TABLE_EXTRACTOR_VERSION = "pdfplumber-local";

export interface CompareArgs {
  readonly pdfs: readonly string[];
  readonly scopePath: string;
  readonly doclingUrl: string;
  readonly doclingVersion: string | null;
  readonly pageRange: PageRange | null;
  readonly outDir: string;
}

export function parseCompareArgs(argv: readonly string[], env: { readonly tmpRoot: string; readonly now: Date }): CompareArgs {
  const pdfs: string[] = [];
  let scopePath = join(REPO_ROOT, "config/access-scopes/117-mirae-mf.yml");
  let doclingUrl = "http://localhost:8090";
  let doclingVersion: string | null = null;
  let pageRange: PageRange | null = null;
  let outDir: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value.`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--pdf": pdfs.push(resolve(value())); break;
      case "--scope": scopePath = resolve(value()); break;
      case "--docling-url": doclingUrl = value(); break;
      case "--docling-version": doclingVersion = value(); break;
      case "--pages": pageRange = parsePageRange(value()); break;
      case "--out": outDir = resolve(value()); break;
      default: throw new Error(`Unknown argument ${flag}.`);
    }
  }
  if (pdfs.length === 0) throw new Error("At least one --pdf <file> is required.");
  const resolvedOut = outDir
    ?? join(env.tmpRoot, "mf-rag-parse-compare", env.now.toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-"));
  const fromData = relative(join(REPO_ROOT, "data"), resolvedOut);
  if (fromData === "" || (!fromData.startsWith("..") && !fromData.startsWith(sep) && !/^[A-Za-z]:/.test(fromData))) {
    throw new Error("--out must not be inside data/; reports are scratch output.");
  }
  return { pdfs, scopePath, doclingUrl, doclingVersion, pageRange, outDir: resolvedOut };
}

/** Holds the one raw PDF; parse outputs are returned by the stages, so `put` only describes them. */
class SinglePdfArtifactStore implements PdfStageArtifactStore {
  constructor(private readonly bytes: Uint8Array) {}

  async readVerified(): Promise<Uint8Array> {
    return this.bytes;
  }

  async put(input: Parameters<PdfStageArtifactStore["put"]>[0]): Promise<ArtifactDescriptor> {
    return {
      key: `${input.namespace}/${input.sha256}`,
      uri: `memory://${input.sha256}`,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mediaType: input.mediaType,
      producerVersion: input.producerVersion,
    };
  }
}

interface ScopeContext {
  readonly key: string;
  readonly knowledgeScope: KnowledgeScope;
  readonly ownership: ClassifiedKnowledgeOwnership;
}

async function loadScope(path: string): Promise<ScopeContext> {
  const manifest = parseAccessScopeManifestYaml(await Bun.file(path).text(), basename(path));
  return {
    key: manifest.accessScopeKey,
    knowledgeScope: { ...manifest.classification },
    ownership: {
      visibilityScope: "TENANT",
      tenantId: manifest.externalCode,
      ownershipManifestId: `parse-compare:${manifest.accessScopeKey}`,
      ownershipManifestVersion: 1,
    },
  };
}

function inspect(parsed: PdfParseArtifact, scope: ScopeContext, sourceDocumentId: string): ComparisonSideInput & { chunkerVersion: string } {
  const inspection = preparePdfChunkInspection({
    parsed,
    sourceDocumentId,
    ownership: scope.ownership,
    knowledgeScope: scope.knowledgeScope,
  });
  const diagnostics = (inspection.prepared.candidates[0]?.metadata as { parserDiagnostics?: ComparisonSideInput["parserDiagnostics"] } | undefined)
    ?.parserDiagnostics ?? null;
  return {
    candidates: inspection.prepared.candidates,
    report: inspection.prepared.report,
    parserDiagnostics: diagnostics,
    chunkerVersion: inspection.chunkerVersion,
  };
}

async function compareOne(path: string, args: CompareArgs, scope: ScopeContext, doclingVersion: string): Promise<ParserComparison> {
  const bytes = await Bun.file(path).bytes();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const filename = basename(path);
  const store = new SinglePdfArtifactStore(bytes);
  const input = {
    documentVersionId: `parse-compare-${sha256.slice(0, 16)}`,
    rawArtifact: {
      key: `raw/${sha256}`,
      uri: `memory://${sha256}`,
      sha256,
      byteSize: bytes.byteLength,
      mediaType: "application/pdf",
      producerVersion: "parse-compare",
    },
    filename,
    canonicalUrl: `https://parse-compare.invalid/${encodeURIComponent(filename)}`,
  };
  const unpdfStage = new ParsePdfStage({ artifactStore: store }, {
    parserVersion: UNPDF_PARSER_VERSION,
    tableExtractorVersion: UNPDF_TABLE_EXTRACTOR_VERSION,
    producerVersion: "parse-compare",
  });
  const doclingStage = new DoclingParseStage({ artifactStore: store }, {
    serviceUrl: args.doclingUrl,
    parserVersion: doclingVersion,
    producerVersion: `parse-compare+${doclingVersion}`,
  });
  const started = performance.now();
  const [unpdf, docling] = await Promise.all([
    unpdfStage.execute(input),
    doclingStage.execute(input).then((result) => {
      console.error(`  docling parsed ${filename} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
      return result;
    }),
  ]);
  if (unpdf.parsed.diagnostics.tableExtractionStatus === "failed") {
    console.error("  warning: unpdf table extraction (pdfplumber) failed; unpdf side has no table chunks");
  }
  const restrict = <T extends PdfParseArtifact>(parsed: T): T =>
    args.pageRange ? restrictArtifactToPages(parsed, args.pageRange) : parsed;
  const sourceDocumentId = `parse-compare:${sha256}`;
  return compareParserInspections({
    filename,
    pageRange: args.pageRange,
    unpdf: {
      ...inspect(restrict(unpdf.parsed), scope, sourceDocumentId),
      tableExtractionStatus: unpdf.parsed.diagnostics.tableExtractionStatus,
    },
    docling: inspect(restrict(docling.parsed), scope, sourceDocumentId),
  });
}

async function main(): Promise<number> {
  const args = parseCompareArgs(process.argv.slice(2), { tmpRoot: tmpdir(), now: new Date() });
  const scope = await loadScope(args.scopePath);
  const doclingVersion = args.doclingVersion ?? (await fetchDoclingHealth(args.doclingUrl)).parserVersion;
  console.error(`Docling ${doclingVersion} at ${args.doclingUrl}; scope ${scope.key}`);

  const comparisons: ParserComparison[] = [];
  const errors: { filename: string; code: string | null; message: string }[] = [];
  for (const pdf of args.pdfs) {
    console.error(`Comparing ${basename(pdf)}${args.pageRange ? ` (pages ${args.pageRange.first}-${args.pageRange.last})` : ""}`);
    try {
      comparisons.push(await compareOne(pdf, args, scope, doclingVersion));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      errors.push({ filename: basename(pdf), code: typeof code === "string" ? code : null, message: (error as Error).message });
      console.error(`  failed: ${typeof code === "string" ? `${code}: ` : ""}${(error as Error).message}`);
    }
  }

  const parserVersions = { unpdf: `${UNPDF_PARSER_VERSION}+${UNPDF_TABLE_EXTRACTOR_VERSION}`, docling: doclingVersion };
  let markdown = renderComparisonMarkdown(comparisons, { parserVersions });
  if (errors.length > 0) {
    markdown += `\n## Failed documents\n\n${errors.map((e) => `- ${e.filename}: ${e.code ?? "ERROR"} ${e.message}`).join("\n")}\n`;
  }
  await mkdir(args.outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    parserVersions,
    scope: scope.key,
    pageRange: args.pageRange,
    documents: comparisons,
    errors,
  };
  await Bun.write(join(args.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await Bun.write(join(args.outDir, "report.md"), markdown);

  const summaryEnd = markdown.indexOf("\n## ", markdown.indexOf("## Summary") + 1);
  console.log((summaryEnd === -1 ? markdown : markdown.slice(0, summaryEnd)).trimEnd());
  console.log(`\nWrote ${join(args.outDir, "report.md")} and report.json`);
  return errors.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main());
}

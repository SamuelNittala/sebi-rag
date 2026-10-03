import type {
  CandidateChunkMetadata,
  ChunkFlagSeverity,
  ChunkFlagStatus,
  ReviewRunStatus,
  ReviewPurpose,
  ReviewSourceType,
} from "@mf-rag/types";
import { miraeSifSectionTypes, miraeSifStrategies } from "@mf-rag/core/metadata-review";
import type {
  RetrievalChunkView,
  RetrievalSearchResult,
} from "../retrieval/mcp-retrieval-search.ts";
import type {
  PageCandidateCard,
  PageViewModel,
  PageWireRecord,
  UnmatchedWireCard,
} from "./page-view/page-view-model.ts";
import type { ReviewSourceErrorCode } from "./page-view/source-artifacts.ts";

export interface ReviewDashboardItem {
  id: string;
  sourceName: string;
  sourceType: ReviewSourceType;
  reviewPurpose?: ReviewPurpose;
  status: ReviewRunStatus;
  candidateChunkCount: number;
  flaggedChunkCount: number;
  criticalCount: number;
  warningCount?: number;
  blockingCount: number;
  parserVersion: string;
  chunkerVersion: string;
  inspectorVersion: string;
  createdAt: Date;
  /** Set for scheduled pipeline runs; with a `docling-` parser version it enables the page view link. */
  pipelineRunId?: string | null;
}

interface ReviewRunView {
  id: string;
  sourceName: string;
  sourceType: ReviewSourceType;
  reviewPurpose?: ReviewPurpose;
  sourceLocation: string | null;
  status: ReviewRunStatus;
  candidateChunkCount: number;
  inspectedChunkCount: number;
  flaggedChunkCount: number;
  criticalCount: number;
  warningCount?: number;
  blockingCount: number;
  parserVersion: string;
  chunkerVersion: string;
  inspectorVersion: string;
  visibilityScope?: "GLOBAL" | "TENANT" | "UNCLASSIFIED";
  tenantId?: string | null;
  ownershipManifestId?: string | null;
  ownershipManifestVersion?: number | null;
  pipelineRunId?: string | null;
}

interface ReviewCandidateView {
  id: string;
  chunkIndex: number;
  text: string;
  pageNumbers: number[];
  tokenCount: number;
  hasTable: boolean;
  sectionHeader: string | null;
  metadata: CandidateChunkMetadata;
  contentHash: string;
  visibilityScope?: "GLOBAL" | "TENANT" | "UNCLASSIFIED";
  tenantId?: string | null;
  ownershipManifestId?: string | null;
  ownershipManifestVersion?: number | null;
}

interface ReviewFlagView {
  id: string;
  chunkCandidateId: string | null;
  chunkIndex: number | null;
  ruleCode: string;
  severity: ChunkFlagSeverity;
  blocksApproval: boolean;
  message: string;
  evidence: Record<string, unknown>;
  status: ChunkFlagStatus;
  reviewer: string | null;
  reviewerNote: string | null;
}

export interface DocumentReviewViewModel {
  run: ReviewRunView;
  candidates: ReviewCandidateView[];
  flags: ReviewFlagView[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * JSON for an inline `<script type="application/json">`: `<`, `>`, `&` and
 * U+2028/U+2029 are escaped so chunk text can never close the element or
 * break a line; `JSON.parse` restores the exact value.
 */
export function serializeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Page view links are offered for scheduled pipeline runs parsed by Docling. */
function hasDoclingPageView(run: { parserVersion: string; pipelineRunId?: string | null }): boolean {
  return run.parserVersion.startsWith("docling-") && Boolean(run.pipelineRunId);
}

function documentHref(runId: string): string {
  return `/review/documents/${encodeURIComponent(runId)}`;
}

function candidatePageHref(runId: string, candidate: { chunkIndex: number; pageNumbers: number[] }): string | null {
  const page = candidate.pageNumbers.length ? Math.min(...candidate.pageNumbers) : null;
  return page === null ? null : `${documentHref(runId)}/pages/${page}#chunk-${candidate.chunkIndex}`;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; color: #17202a; background: #f5f7fa; }
    body { margin: 0; }
    main { max-width: 1440px; margin: 0 auto; padding: 24px; }
    a { color: #175cd3; }
    .top { display: flex; align-items: start; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
    .summary { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill { border: 1px solid #d0d5dd; background: white; border-radius: 999px; padding: 5px 10px; font-size: 13px; }
    .critical { border-color: #fda29b; background: #fff1f0; }
    .warning { border-color: #fec84b; background: #fffaeb; }
    .info { border-color: #84caff; background: #eff8ff; }
    table { width: 100%; border-collapse: collapse; background: white; }
    th, td { padding: 11px; border-bottom: 1px solid #eaecf0; text-align: left; vertical-align: top; }
    th { background: #f9fafb; font-size: 13px; }
    .flag { background: white; border: 1px solid #d0d5dd; border-left-width: 5px; border-radius: 8px; margin: 16px 0; padding: 16px; }
    .flag.critical { border-left-color: #d92d20; }
    .flag.warning { border-left-color: #dc6803; }
    .flag.info { border-left-color: #1570ef; }
    .flag-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .context-grid { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 12px; margin-top: 14px; }
    .context { border: 1px solid #eaecf0; border-radius: 6px; padding: 10px; min-width: 0; }
    .context.current { border-color: #84adff; background: #f5f8ff; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, monospace; margin: 6px 0 0; }
    .muted { color: #667085; font-size: 13px; }
    form { margin-top: 12px; }
    textarea { width: 100%; min-height: 58px; box-sizing: border-box; padding: 8px; }
    button { margin: 8px 8px 0 0; padding: 8px 12px; cursor: pointer; }
    .approve { background: #067647; color: white; border: 0; border-radius: 5px; }
    .reject { background: #b42318; color: white; border: 0; border-radius: 5px; }
    .document-actions { background: white; border: 1px solid #d0d5dd; padding: 16px; border-radius: 8px; margin-top: 24px; }
    .candidate-editor { background: white; border: 1px solid #d0d5dd; border-radius: 8px; margin: 14px 0; padding: 16px; }
    .candidate-editor textarea { min-height: 180px; font: 13px/1.45 ui-monospace, monospace; }
    .search-form { display: flex; gap: 10px; padding: 16px; background: white; border: 1px solid #d0d5dd; border-radius: 10px; }
    .search-form input { flex: 1; min-width: 0; padding: 11px 12px; border: 1px solid #98a2b3; border-radius: 6px; font-size: 15px; }
    .search-form button { margin: 0; border: 0; border-radius: 6px; padding: 10px 18px; color: white; background: #175cd3; font-weight: 600; }
    .retrieval-result { margin: 16px 0; padding: 18px; border: 1px solid #d0d5dd; border-radius: 10px; background: white; }
    .rank-badge { display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; padding: 6px 10px; background: #101828; color: white; font-weight: 700; }
    .score { font: 700 18px/1 ui-monospace, monospace; color: #175cd3; }
    .trace-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
    .trace-cell { border: 1px solid #eaecf0; border-radius: 6px; padding: 8px; }
    .trace-cell strong { display: block; margin-top: 4px; font: 600 13px/1.3 ui-monospace, monospace; }
    .signal { display: inline-block; margin: 0 5px 5px 0; padding: 4px 7px; border-radius: 5px; background: #ecfdf3; color: #067647; font: 12px/1.2 ui-monospace, monospace; }
    .error-panel { border: 1px solid #fda29b; background: #fff1f0; color: #912018; border-radius: 8px; padding: 12px; margin-top: 16px; }
    .metadata-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
    .metadata-grid label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; }
    .metadata-grid input, .metadata-grid select { padding: 8px; border: 1px solid #d0d5dd; border-radius: 5px; background: white; }
    .page-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 16px; padding: 10px 12px; background: white; border: 1px solid #d0d5dd; border-radius: 8px; }
    .page-nav form { display: flex; gap: 6px; margin: 0; }
    .page-nav select { padding: 6px; max-width: 320px; }
    .page-nav button { margin: 0; padding: 6px 10px; }
    .page-nav .nav-link[aria-disabled="true"] { color: #98a2b3; pointer-events: none; }
    .page-nav label { margin-left: auto; font-size: 13px; display: flex; gap: 6px; align-items: center; }
    .page-view { --type-text: #175cd3; --type-table: #067647; --type-key_value: #dc6803; --type-picture: #7a5af8; display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 20px; align-items: start; }
    .page-canvas-col { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow: auto; background: white; border: 1px solid #d0d5dd; border-radius: 8px; padding: 10px; }
    .page-stage { position: relative; width: 100%; }
    .page-stage canvas { display: block; width: 100%; height: auto; }
    .page-boxes { position: absolute; inset: 0; }
    .page-view.boxes-hidden .page-boxes { display: none; }
    .page-box { position: absolute; box-sizing: border-box; border: 2px solid var(--box-color, #175cd3); background: color-mix(in srgb, var(--box-color, #175cd3) 8%, transparent); cursor: pointer; }
    .page-box.unmatched { border-style: dashed; }
    .page-box.active, .page-box.selected { background: color-mix(in srgb, var(--box-color, #175cd3) 24%, transparent); border-width: 3px; z-index: 2; }
    .page-box-label { position: absolute; top: -1px; left: -1px; padding: 0 4px; font: 600 10px/14px ui-monospace, monospace; color: white; background: var(--box-color, #175cd3); }
    .type-text { --box-color: var(--type-text); }
    .type-table { --box-color: var(--type-table); }
    .type-key_value { --box-color: var(--type-key_value); }
    .type-picture { --box-color: var(--type-picture); }
    .type-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font: 600 12px/18px ui-monospace, monospace; color: white; background: var(--box-color, #667085); }
    .page-legend { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .page-status { margin: 8px 0 0; }
    .page-cards h2 { font-size: 16px; margin: 18px 0 8px; }
    .page-card { background: white; border: 1px solid #d0d5dd; border-left: 5px solid var(--box-color, #d0d5dd); border-radius: 8px; padding: 12px; margin: 0 0 12px; scroll-margin-top: 12px; }
    .page-card.unmatched { border-left-style: dashed; }
    .page-card.active { box-shadow: 0 0 0 2px color-mix(in srgb, var(--box-color, #175cd3) 45%, transparent); }
    .page-card.selected { box-shadow: 0 0 0 3px var(--box-color, #175cd3); }
    .page-card pre { max-height: 260px; overflow: auto; }
    .page-flags { list-style: none; padding: 0; margin: 8px 0; }
    .page-flags li { margin: 4px 0; font-size: 13px; }
    .wire-record summary { font-size: 13px; cursor: pointer; }
    .wire-record dt { font-weight: 600; font-size: 12px; margin-top: 6px; }
    .wire-record dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
    @media (max-width: 1100px) { .page-view { grid-template-columns: 1fr; } .page-canvas-col { position: static; max-height: none; } }
    @media (max-width: 900px) { .context-grid { grid-template-columns: 1fr; } .trace-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderReviewDashboard(runs: ReviewDashboardItem[]): string {
  const rows = runs.map((run) => `<tr>
    <td><a href="/review/documents/${escapeHtml(run.id)}">${escapeHtml(run.sourceName)}</a><div class="muted">${escapeHtml(run.sourceType)} · ${escapeHtml(run.reviewPurpose ?? "content")} review${hasDoclingPageView(run) ? ` · <a href="${escapeHtml(documentHref(run.id))}/pages">Pages</a>` : ""}</div></td>
    <td>${escapeHtml(run.status)}</td>
    <td>${run.candidateChunkCount} chunks</td>
    <td>${run.flaggedChunkCount} flagged</td>
    <td>${run.blockingCount} blocking</td>
    <td><span class="muted">parser ${escapeHtml(run.parserVersion)}<br>chunker ${escapeHtml(run.chunkerVersion)}<br>inspector ${escapeHtml(run.inspectorVersion)}</span></td>
    <td>${escapeHtml(run.createdAt.toISOString())}</td>
  </tr>`).join("");

  return layout("Chunk review", `<div class="top"><div><h1>Chunk review</h1><p class="muted">Candidate chunks awaiting production approval.</p></div><a href="/review/search">Open retrieval debugger →</a></div>
  <table><thead><tr><th>Document</th><th>Status</th><th>Chunks</th><th>Flags</th><th>Approval</th><th>Versions</th><th>Created</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No review runs found.</td></tr>'}</tbody></table>`);
}

export interface RetrievalSearchViewModel {
  query: string;
  result?: RetrievalSearchResult;
  error?: string;
}

function score(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(3) : "—";
}

function rank(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function chunkTitle(chunk: RetrievalChunkView): string {
  return chunk.fundName
    ?? chunk.documentTitle
    ?? chunk.documentFilename
    ?? chunk.sourceType;
}

function chunkLocation(chunk: RetrievalChunkView): string {
  const values = [
    chunk.documentFilename,
    chunk.docType,
    chunk.pageNumbers?.length ? `pages ${chunk.pageNumbers.join(", ")}` : undefined,
    chunk.sectionHeader ?? undefined,
    chunk.contentCategory,
    chunk.publisher,
    chunk.sourceDate,
    chunk.question ?? chunk.topic,
  ];
  return values.filter(Boolean).join(" · ");
}

function traceCell(label: string, value: string): string {
  return `<div class="trace-cell"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderRetrievalChunk(chunk: RetrievalChunkView): string {
  const trace = chunk.retrievalTrace;
  const signals = trace?.metadataSignals.map(
    (signal) => `<span class="signal">${escapeHtml(signal)}</span>`,
  ).join("") ?? "";
  const sourceUrl = safeExternalUrl(chunk.sebiUrl ?? chunk.sourceUrl);
  const location = chunkLocation(chunk);
  const metadata = {
    chunkId: chunk.chunkId,
    sourceType: chunk.sourceType,
    retrievalMetadata: chunk.retrievalMetadata,
  };
  return `<article class="retrieval-result">
    <div class="flag-head"><div><span class="rank-badge">Rank ${chunk.rank}</span> <strong>${escapeHtml(chunkTitle(chunk))}</strong></div><span class="score">${score(chunk.score)}</span></div>
    ${(location || sourceUrl) ? `<p class="muted">${escapeHtml(location)}${location && sourceUrl ? " · " : ""}${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">source</a>` : ""}</p>` : ""}
    ${trace ? `<div class="trace-grid">
      ${traceCell("Dense rank", rank(trace.denseRank))}
      ${traceCell("Dense score", score(trace.denseScore))}
      ${traceCell("Lexical rank", rank(trace.lexicalRank))}
      ${traceCell("Lexical score", score(trace.lexicalScore))}
      ${traceCell("RRF score", score(trace.rrfScore))}
      ${traceCell("Metadata boost", `${trace.metadataAdjustment >= 0 ? "+" : ""}${score(trace.metadataAdjustment)}`)}
      ${traceCell("Pre-rerank", rank(trace.preRerankRank))}
      ${traceCell("Rerank score", score(trace.rerankScore))}
    </div>${signals ? `<div>${signals}</div>` : ""}` : '<p class="muted">No retrieval trace returned.</p>'}
    <pre>${escapeHtml(chunk.text)}</pre>
    <details><summary>Chunk metadata</summary><pre>${escapeHtml(JSON.stringify(metadata, null, 2))}</pre></details>
  </article>`;
}

export function renderRetrievalSearch(model: RetrievalSearchViewModel): string {
  const result = model.result;
  const chunks = result?.chunks
    .slice()
    .sort((left, right) => left.rank - right.rank)
    .map(renderRetrievalChunk)
    .join("") ?? "";
  const intent = result?.intent;
  const reranking = result?.reranking;
  const summary = result
    ? `<div class="summary" style="margin-top: 16px">
      <span class="pill">${result.chunks.length} chunks</span>
      <span class="pill">${result.queryTimeMs} ms</span>
      <span class="pill">${result.denseCandidates} dense candidates</span>
      <span class="pill">${result.lexicalCandidates} lexical candidates</span>
      <span class="pill">${escapeHtml(result.fusion.toUpperCase())} k=${result.rrfK}</span>
      <span class="pill ${reranking?.applied ? "info" : ""}">rerank: ${reranking?.applied ? `${escapeHtml(reranking.model ?? reranking.provider ?? "enabled")} (${reranking.candidates})` : "disabled/fallback"}</span>
      ${reranking?.fallbackReason ? `<span class="pill critical">${escapeHtml(reranking.fallbackReason)}</span>` : ""}
      <span class="pill info">fact: ${escapeHtml(intent?.factType ?? "none")}</span>
      <span class="pill info">strategy: ${escapeHtml(intent?.strategyId ?? "none")}</span>
      <span class="pill info">scope: ${escapeHtml(intent?.preferredDocumentScope ?? "none")}</span>
    </div>`
    : "";
  return layout("Retrieval debugger", `<p><a href="/review">← Chunk review</a></p>
    <div class="top"><div><h1>Retrieval debugger</h1><p class="muted">Runs the production query_mutual_funds retrieval path and shows the returned chunks in final ranking order.</p></div></div>
    <form class="search-form" method="get" action="/review/search">
      <input name="q" value="${escapeHtml(model.query)}" maxlength="500" required autofocus placeholder="Ask a mutual fund question">
      <button type="submit">Run retrieval</button>
    </form>
    ${model.error ? `<div class="error-panel">${escapeHtml(model.error)}</div>` : ""}
    ${summary}
    ${result && result.chunks.length === 0 ? '<p class="retrieval-result">No chunks returned.</p>' : chunks}`);
}

function contextCard(label: string, candidate: ReviewCandidateView | undefined, current = false): string {
  if (!candidate) return `<div class="context"><strong>${label}</strong><p class="muted">None</p></div>`;
  return `<div class="context${current ? " current" : ""}"><strong>${label}: chunk ${candidate.chunkIndex}</strong>
    <div class="muted">Pages ${escapeHtml(candidate.pageNumbers.join(", "))} · ${candidate.tokenCount} tokens${candidate.sectionHeader ? ` · ${escapeHtml(candidate.sectionHeader)}` : ""}</div>
    <pre>${escapeHtml(candidate.text)}</pre></div>`;
}

function flagActions(flag: ReviewFlagView): string {
  if (flag.status !== "open") {
    return `<p class="muted">${escapeHtml(flag.status)} by ${escapeHtml(flag.reviewer)}: ${escapeHtml(flag.reviewerNote)}</p>`;
  }
  return `<form method="post" action="/review/flags/${escapeHtml(flag.id)}">
    <textarea name="note" required placeholder="Reviewer note"></textarea>
    <button name="decision" value="accepted">Accept false positive</button>
    <button name="decision" value="resolved">Mark resolved</button>
  </form>`;
}

function option(value: string, selected: unknown): string {
  return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`;
}

function ownershipSummary(owner: ReviewRunView | ReviewCandidateView): string {
  const scope = owner.visibilityScope ?? "UNCLASSIFIED";
  const tenant = owner.tenantId ? ` · Tenant ${owner.tenantId}` : "";
  const manifest = owner.ownershipManifestId && owner.ownershipManifestVersion
    ? ` · Manifest ${owner.ownershipManifestId} v${owner.ownershipManifestVersion}`
    : "";
  return `<div class="muted ownership" aria-label="Read-only ownership">Ownership: ${escapeHtml(scope)}${escapeHtml(tenant)}${escapeHtml(manifest)}</div>`;
}

function metadataEditor(candidate: ReviewCandidateView, editable: boolean): string {
  const metadata = candidate.metadata;
  const fields = `<div class="metadata-grid">
    <label>Document scope<select name="documentScope">${[
      "strategy", "sif_umbrella", "amc", "regulatory", "unknown",
    ].map((value) => option(value, metadata.documentScope)).join("")}</select></label>
    <label>Strategy<select name="strategyId">${[
      { id: "", name: "Not strategy-specific" },
      ...miraeSifStrategies,
    ].map((strategy) => `<option value="${escapeHtml(strategy.id)}"${strategy.id === metadata.strategyId || (!strategy.id && !metadata.strategyId) ? " selected" : ""}>${escapeHtml(strategy.name)}</option>`).join("")}</select></label>
    <label>Section type<select name="sectionType">${miraeSifSectionTypes.map(
      (value) => option(value, metadata.sectionType ?? "unknown"),
    ).join("")}</select></label>
    <label>Fact type<select name="factType">${["", "fund_manager", ...miraeSifSectionTypes.filter(
      (value) => !["strategy_management", "staff_directory", "fund_facts", "overview", "unknown"].includes(value),
    )].map((value) => option(value, metadata.factType ?? "")).join("")}</select></label>
  </div>`;
  if (!editable) return `${fields}<p class="muted">This metadata run is no longer editable.</p>`;
  return `<form method="post" action="/review/candidates/${escapeHtml(candidate.id)}/metadata">
    <input type="hidden" name="expectedContentHash" value="${escapeHtml(candidate.contentHash)}">
    ${fields}
    <textarea name="note" required placeholder="What source evidence did you verify?"></textarea>
    <button class="approve" type="submit">Save reviewed metadata</button>
  </form>`;
}

export function renderDocumentReview(model: DocumentReviewViewModel): string {
  const pageView = hasDoclingPageView(model.run);
  const candidatesById = new Map(model.candidates.map((candidate) => [candidate.id, candidate]));
  const candidatePosition = new Map(model.candidates.map((candidate, index) => [candidate.id, index]));
  const cards = model.flags.map((flag) => {
    const current = flag.chunkCandidateId ? candidatesById.get(flag.chunkCandidateId) : undefined;
    const position = flag.chunkCandidateId ? candidatePosition.get(flag.chunkCandidateId) : undefined;
    const previous = position === undefined ? undefined : model.candidates[position - 1];
    const next = position === undefined ? undefined : model.candidates[position + 1];
    const pageHref = pageView && current ? candidatePageHref(model.run.id, current) : null;
    return `<section class="flag ${escapeHtml(flag.severity)}" id="flag-${escapeHtml(flag.id)}" data-status="${escapeHtml(flag.status)}">
      <div class="flag-head"><div><strong>${escapeHtml(flag.ruleCode)}</strong> <span class="pill ${escapeHtml(flag.severity)}">${escapeHtml(flag.severity)}</span>${flag.blocksApproval ? ' <span class="pill critical">blocks approval</span>' : ""}</div><span class="muted">${pageHref ? `<a href="${escapeHtml(pageHref)}">View page ${Math.min(...current!.pageNumbers)}</a> · ` : ""}${escapeHtml(flag.status)}</span></div>
      <p>${escapeHtml(flag.message)}</p>
      <div class="context-grid">${contextCard("Previous", previous)}${contextCard("Flagged", current, true)}${contextCard("Next", next)}</div>
      <details><summary>Evidence and metadata</summary><pre>${escapeHtml(JSON.stringify({ evidence: flag.evidence, metadata: current?.metadata ?? null }, null, 2))}</pre></details>
      ${flagActions(flag)}
    </section>`;
  }).join("");

  const run = model.run;
  const approvalDisabled = run.blockingCount > 0
    || (run.warningCount ?? 0) > 0
    || run.inspectedChunkCount !== run.candidateChunkCount;
  const decisionPanel = run.status === "review_ready"
    ? `<section class="document-actions"><h2>Document decision</h2>
      <form method="post" action="/review/documents/${escapeHtml(run.id)}/decision">
        <textarea name="note" required placeholder="Document review note"></textarea>
        <button class="approve" name="decision" value="approve"${approvalDisabled ? " disabled" : ""}>Approve document</button>
        <button class="reject" name="decision" value="reject">Reject document</button>
      </form>${approvalDisabled ? '<p class="muted">Approval is disabled until every blocking finding is reviewed.</p>' : ""}
    </section>`
    : run.status === "approved" || run.status === "failed"
      ? `<section class="document-actions"><h2>${run.status === "failed" ? "Retry publication" : "Ready to publish"}</h2>
        <p>Run <code>bun run review:publish ${escapeHtml(run.id)} --actor &lt;name&gt;</code> on the ingestion host.</p>
      </section>`
      : `<section class="document-actions"><h2>Workflow status</h2><p>This review run is ${escapeHtml(run.status)}.</p></section>`;
  return layout(run.sourceName, `<p><a href="/review">← All documents</a> · <a href="/review/documents/${escapeHtml(run.id)}/chunks">Edit all candidate chunks</a>${pageView ? ` · <a href="${escapeHtml(documentHref(run.id))}/pages">Page view</a>` : ""}</p>
    <div class="top"><div><h1>${escapeHtml(run.sourceName)}</h1><p class="muted">${escapeHtml(run.sourceLocation)}</p></div>
    <div class="summary"><span class="pill">${escapeHtml(run.reviewPurpose ?? "content")} review</span><span class="pill">${escapeHtml(run.status)}</span><span class="pill">${run.inspectedChunkCount}/${run.candidateChunkCount} inspected</span><span class="pill critical">${run.blockingCount} blocking</span><span class="pill warning">${run.warningCount ?? 0} warnings to acknowledge</span></div></div>
    <p class="muted">Parser ${escapeHtml(run.parserVersion)} · Chunker ${escapeHtml(run.chunkerVersion)} · Inspector ${escapeHtml(run.inspectorVersion)}</p>
    ${ownershipSummary(run)}
    <h2>Flagged chunks (${model.flags.length})</h2>
    ${cards || "<p>No inspection findings.</p>"}
    ${decisionPanel}`);
}

export function renderCandidateEditor(model: DocumentReviewViewModel): string {
  const editable = model.run.status === "review_ready";
  const metadataReview = model.run.reviewPurpose === "metadata";
  const pageView = hasDoclingPageView(model.run);
  const pageLink = (candidate: ReviewCandidateView): string => {
    const href = pageView ? candidatePageHref(model.run.id, candidate) : null;
    return href ? ` · <a href="${escapeHtml(href)}">View on page ${Math.min(...candidate.pageNumbers)}</a>` : "";
  };
  const candidates = model.candidates.map((candidate) => `<section class="candidate-editor" id="${escapeHtml(candidate.id)}">
    <div class="flag-head"><strong>Chunk ${candidate.chunkIndex}</strong><span class="muted">Pages ${escapeHtml(candidate.pageNumbers.join(", "))} · ${candidate.tokenCount} tokens${candidate.sectionHeader ? ` · ${escapeHtml(candidate.sectionHeader)}` : ""}${pageLink(candidate)}</span></div>
    ${ownershipSummary(candidate)}
    ${metadataReview ? `<pre>${escapeHtml(candidate.text)}</pre>
      ${metadataEditor(candidate, editable)}
      <details><summary>Classification evidence</summary><pre>${escapeHtml(JSON.stringify({
        source: candidate.metadata.classificationSource,
        confidence: candidate.metadata.confidence,
        evidence: candidate.metadata.evidence,
      }, null, 2))}</pre></details>` : editable ? `<form method="post" action="/review/candidates/${escapeHtml(candidate.id)}/edit">
      <input type="hidden" name="expectedContentHash" value="${escapeHtml(candidate.contentHash)}">
      <textarea name="text" required>${escapeHtml(candidate.text)}</textarea>
      <textarea name="note" required placeholder="Why are you changing this chunk? Include the source page checked."></textarea>
      <button class="approve" type="submit">Save and reinspect document</button>
    </form>` : `<pre>${escapeHtml(candidate.text)}</pre><p class="muted">This run is ${escapeHtml(model.run.status)} and can no longer be edited.</p>`}
    <details><summary>Metadata</summary><pre>${escapeHtml(JSON.stringify(candidate.metadata, null, 2))}</pre></details>
  </section>`).join("");

  const heading = metadataReview ? "Review chunk metadata" : "Edit all candidate chunks";
  const description = metadataReview
    ? `${model.run.sourceName} · Source text and embeddings remain unchanged.`
    : `${model.run.sourceName} · Saving any edit reinspects all ${model.run.candidateChunkCount} chunks and resets flag decisions.`;
  return layout(`${heading}: ${model.run.sourceName}`, `<p><a href="/review/documents/${escapeHtml(model.run.id)}">← Document review</a></p>
    <div class="top"><div><h1>${escapeHtml(heading)}</h1><p class="muted">${escapeHtml(description)}</p></div><span class="pill">${escapeHtml(model.run.status)}</span></div>
    ${candidates || "<p>No candidate chunks.</p>"}`);
}

/** Asset URLs the page view references (versioned; see `page-view/assets.ts`). */
export interface PageViewAssets {
  readonly clientUrl: string;
  readonly pdfjsUrl: string;
  readonly pdfjsWorkerUrl: string;
}

const CHUNK_TYPES = ["text", "table", "key_value", "picture"] as const;

function typeClass(type: string | null): string {
  return type && (CHUNK_TYPES as readonly string[]).includes(type) ? `type-${type}` : "";
}

function typeTag(type: string | null): string {
  return type ? `<span class="type-tag ${typeClass(type)}">${escapeHtml(type)}</span>` : "";
}

function wireDetails(record: PageWireRecord): string {
  const field = (label: string, value: string): string => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
  const list = (values: readonly string[]): string => values.length ? escapeHtml(values.join(", ")) : '<span class="muted">none</span>';
  return `<details class="wire-record"><summary>Docling chunk w${record.chunkIndex} · ${escapeHtml(record.type)} · ${record.bboxCount} ${record.bboxCount === 1 ? "box" : "boxes"} on this page</summary>
    <dl>
      ${field("Headings", record.headings.length ? escapeHtml(record.headings.join(" › ")) : '<span class="muted">none</span>')}
      ${field("Pages", escapeHtml(record.pages.join(", ")))}
      ${field("Item refs", list(record.itemRefs))}
      ${field("Normalization flags", list(record.flags))}
      ${record.pictureClassification ? field("Picture classification", escapeHtml(record.pictureClassification)) : ""}
    </dl>
    <pre>${escapeHtml(record.text)}</pre>
  </details>`;
}

function pageCandidateCard(card: PageCandidateCard): string {
  const type = card.wire?.type ?? card.chunkType;
  const flags = card.openFlags.length
    ? `<ul class="page-flags">${card.openFlags.map((flag) => `<li><span class="pill ${escapeHtml(flag.severity)}">${escapeHtml(flag.severity)}</span> <a href="${escapeHtml(flag.href)}">${escapeHtml(flag.ruleCode)}</a>${flag.blocksApproval ? ' <span class="pill critical">blocks approval</span>' : ""} ${escapeHtml(flag.message)}</li>`).join("")}</ul>`
    : "";
  const normalization = card.normalizationFlags.length
    ? `<div class="summary">${card.normalizationFlags.map((flag) => `<span class="signal">${escapeHtml(flag)}</span>`).join("")}</div>`
    : "";
  return `<article class="page-card ${typeClass(type)}" id="${escapeHtml(card.anchorId)}" data-target-id="${escapeHtml(card.anchorId)}">
    <div class="flag-head"><div><strong>Chunk ${card.chunkIndex}</strong> ${typeTag(type)}${card.edited ? ` <span class="pill warning">edited (${card.editCount})</span>` : ""}</div><span class="muted">Pages ${escapeHtml(card.pageNumbers.join(", "))}</span></div>
    ${card.sectionHeader ? `<div class="muted">${escapeHtml(card.sectionHeader)}</div>` : ""}
    ${flags}
    ${normalization}
    <pre>${escapeHtml(card.text)}</pre>
    ${card.wire ? wireDetails(card.wire) : '<p class="muted">No Docling geometry for this candidate.</p>'}
    <p class="muted"><a href="${escapeHtml(card.editorHref)}">Edit in candidate editor</a></p>
  </article>`;
}

function unmatchedWireCard(card: UnmatchedWireCard): string {
  return `<article class="page-card unmatched ${typeClass(card.record.type)}" id="${escapeHtml(card.anchorId)}" data-target-id="${escapeHtml(card.anchorId)}">
    <div class="flag-head"><div><strong>Docling chunk w${card.chunkIndex}</strong> ${typeTag(card.record.type)}</div><span class="muted">Pages ${escapeHtml(card.record.pages.join(", "))}</span></div>
    <p class="muted">No review candidate maps to this Docling chunk.</p>
    ${wireDetails(card.record)}
  </article>`;
}

function navLink(href: string | null, label: string): string {
  return href
    ? `<a class="nav-link" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    : `<span class="nav-link muted" aria-disabled="true">${escapeHtml(label)}</span>`;
}

export function renderDocumentPageView(model: PageViewModel, assets: PageViewAssets): string {
  const pagesHref = `${model.documentReviewHref}/pages`;
  const pageHref = (page: number | null): string | null => page === null ? null : `${pagesHref}/${page}`;
  const openFlagCount = [...model.cards, ...model.candidatesWithoutGeometry]
    .reduce((sum, card) => sum + card.openFlags.length, 0);
  const candidateCount = model.cards.length + model.candidatesWithoutGeometry.length;
  const cards = model.cards.map(pageCandidateCard).join("");
  const withoutGeometry = model.candidatesWithoutGeometry.length
    ? `<h2>Candidates without Docling geometry (${model.candidatesWithoutGeometry.length})</h2>${model.candidatesWithoutGeometry.map(pageCandidateCard).join("")}`
    : "";
  const unmatched = model.unmatchedWire.length
    ? `<h2>Docling chunks not in candidates (${model.unmatchedWire.length})</h2>${model.unmatchedWire.map(unmatchedWireCard).join("")}`
    : "";
  const empty = !cards && !withoutGeometry && !unmatched ? "<p>No Docling chunks or candidates on this page.</p>" : "";
  return layout(`p${model.page}: ${model.run.sourceName}`, `<p><a href="${escapeHtml(model.documentReviewHref)}">← Document review</a> · <a href="${escapeHtml(model.candidateEditorHref)}">Candidate editor</a></p>
    <div class="top"><div><h1>${escapeHtml(model.run.sourceName)}</h1><p class="muted">Page ${model.page} of ${model.pageCount} · Parser ${escapeHtml(model.run.parserVersion)} · read-only</p></div>
    <div class="summary"><span class="pill">${escapeHtml(model.run.status)}</span><span class="pill">${candidateCount} candidates on page</span><span class="pill${openFlagCount ? " critical" : ""}">${openFlagCount} open findings</span></div></div>
    <nav class="page-nav" aria-label="Pages">
      ${navLink(pageHref(model.nav.prev), "← Previous")}
      <form method="get" action="${escapeHtml(pagesHref)}"><select name="page" aria-label="Page" id="page-picker">${model.picker.map((option) => `<option value="${option.page}"${option.selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select><button type="submit">Go</button></form>
      ${navLink(pageHref(model.nav.next), "Next →")}
      ${navLink(pageHref(model.nav.nextWithFindings), "Next page with findings →")}
      <label><input type="checkbox" id="toggle-boxes" checked> Show boxes</label>
    </nav>
    <div class="page-view" id="page-view" data-page="${model.page}" data-pdf-url="${escapeHtml(model.pdfUrl)}" data-pdfjs-url="${escapeHtml(assets.pdfjsUrl)}" data-pdfjs-worker-url="${escapeHtml(assets.pdfjsWorkerUrl)}">
      <section class="page-canvas-col" aria-label="PDF page ${model.page}">
        <div class="page-stage" id="page-stage"><canvas id="page-canvas"></canvas><div class="page-boxes" id="page-boxes"></div></div>
        <p class="page-status muted" id="page-status">Loading page…</p>
        <noscript><p class="error-panel">The page image needs JavaScript; the chunk cards still work without it.</p></noscript>
        <div class="page-legend">${CHUNK_TYPES.map((type) => typeTag(type)).join("")}<span class="muted">dashed: no matching candidate</span></div>
      </section>
      <section class="page-cards" aria-label="Candidates on page ${model.page}">${cards}${withoutGeometry}${unmatched}${empty}</section>
    </div>
    <script type="application/json" id="page-view-data">${serializeJsonForScript(model.data)}</script>
    <script type="module" src="${escapeHtml(assets.clientUrl)}"></script>`);
}

export type PageViewUnavailableReason =
  | { readonly kind: "no_lineage"; readonly reason: "legacy_run" | "parse_output_missing"; readonly parserVersion: string }
  | { readonly kind: "not_docling"; readonly parserVersion: string; readonly mediaType?: string }
  /** The API has no artifact store configured (503). */
  | { readonly kind: "disabled" }
  /** Lineage or artifact integrity failure (502); only the code is shown. */
  | { readonly kind: "error"; readonly code: ReviewSourceErrorCode };

export function renderPageViewUnavailable(input: { runId: string; reason: PageViewUnavailableReason }): string {
  const { reason } = input;
  const message = reason.kind === "no_lineage"
    ? reason.reason === "legacy_run"
      ? `Page view needs a Docling-parsed pipeline run; this run has no pipeline lineage (parser <code>${escapeHtml(reason.parserVersion)}</code>).`
      : `Page view needs a Docling-parsed pipeline run; this run's pipeline run has no successful PARSE output (parser <code>${escapeHtml(reason.parserVersion)}</code>).`
    : reason.kind === "not_docling"
      ? `Page view needs a Docling-parsed pipeline run; this run was parsed by <code>${escapeHtml(reason.parserVersion)}</code>.`
      : reason.kind === "disabled"
        ? "Page view is disabled: ARTIFACT_STORE is not configured on this server."
        : `The source artifacts for this run could not be loaded (error <code>${escapeHtml(reason.code)}</code>).`;
  const panelClass = reason.kind === "error" || reason.kind === "disabled" ? "error-panel" : "document-actions";
  return layout("Page view unavailable", `<p><a href="${escapeHtml(documentHref(input.runId))}">← Document review</a> · <a href="${escapeHtml(documentHref(input.runId))}/chunks">Candidate editor</a></p>
    <h1>Page view unavailable</h1>
    <div class="${panelClass}"><p>${message}</p></div>`);
}

import type {
  CandidateChunkMetadata,
  ChunkFlagSeverity,
  ChunkFlagStatus,
  ReviewRunStatus,
  ReviewPurpose,
  ReviewSourceType,
} from "@mf-rag/types";
import { miraeSifSectionTypes, miraeSifStrategies } from "@mf-rag/core/metadata-review";

export interface ReviewDashboardItem {
  id: string;
  sourceName: string;
  sourceType: ReviewSourceType;
  reviewPurpose?: ReviewPurpose;
  status: ReviewRunStatus;
  candidateChunkCount: number;
  flaggedChunkCount: number;
  criticalCount: number;
  blockingCount: number;
  parserVersion: string;
  chunkerVersion: string;
  inspectorVersion: string;
  createdAt: Date;
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
  blockingCount: number;
  parserVersion: string;
  chunkerVersion: string;
  inspectorVersion: string;
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
    .metadata-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
    .metadata-grid label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; }
    .metadata-grid input, .metadata-grid select { padding: 8px; border: 1px solid #d0d5dd; border-radius: 5px; background: white; }
    @media (max-width: 900px) { .context-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderReviewDashboard(runs: ReviewDashboardItem[]): string {
  const rows = runs.map((run) => `<tr>
    <td><a href="/review/documents/${escapeHtml(run.id)}">${escapeHtml(run.sourceName)}</a><div class="muted">${escapeHtml(run.sourceType)} · ${escapeHtml(run.reviewPurpose ?? "content")} review</div></td>
    <td>${escapeHtml(run.status)}</td>
    <td>${run.candidateChunkCount} chunks</td>
    <td>${run.flaggedChunkCount} flagged</td>
    <td>${run.blockingCount} blocking</td>
    <td><span class="muted">parser ${escapeHtml(run.parserVersion)}<br>chunker ${escapeHtml(run.chunkerVersion)}<br>inspector ${escapeHtml(run.inspectorVersion)}</span></td>
    <td>${escapeHtml(run.createdAt.toISOString())}</td>
  </tr>`).join("");

  return layout("Chunk review", `<div class="top"><div><h1>Chunk review</h1><p class="muted">Candidate chunks awaiting production approval.</p></div></div>
  <table><thead><tr><th>Document</th><th>Status</th><th>Chunks</th><th>Flags</th><th>Approval</th><th>Versions</th><th>Created</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No review runs found.</td></tr>'}</tbody></table>`);
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
  const candidatesById = new Map(model.candidates.map((candidate) => [candidate.id, candidate]));
  const candidatePosition = new Map(model.candidates.map((candidate, index) => [candidate.id, index]));
  const cards = model.flags.map((flag) => {
    const current = flag.chunkCandidateId ? candidatesById.get(flag.chunkCandidateId) : undefined;
    const position = flag.chunkCandidateId ? candidatePosition.get(flag.chunkCandidateId) : undefined;
    const previous = position === undefined ? undefined : model.candidates[position - 1];
    const next = position === undefined ? undefined : model.candidates[position + 1];
    return `<section class="flag ${escapeHtml(flag.severity)}" data-status="${escapeHtml(flag.status)}">
      <div class="flag-head"><div><strong>${escapeHtml(flag.ruleCode)}</strong> <span class="pill ${escapeHtml(flag.severity)}">${escapeHtml(flag.severity)}</span>${flag.blocksApproval ? ' <span class="pill critical">blocks approval</span>' : ""}</div><span class="muted">${escapeHtml(flag.status)}</span></div>
      <p>${escapeHtml(flag.message)}</p>
      <div class="context-grid">${contextCard("Previous", previous)}${contextCard("Flagged", current, true)}${contextCard("Next", next)}</div>
      <details><summary>Evidence and metadata</summary><pre>${escapeHtml(JSON.stringify({ evidence: flag.evidence, metadata: current?.metadata ?? null }, null, 2))}</pre></details>
      ${flagActions(flag)}
    </section>`;
  }).join("");

  const run = model.run;
  const approvalDisabled = run.blockingCount > 0 || run.inspectedChunkCount !== run.candidateChunkCount;
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
  return layout(run.sourceName, `<p><a href="/review">← All documents</a> · <a href="/review/documents/${escapeHtml(run.id)}/chunks">Edit all candidate chunks</a></p>
    <div class="top"><div><h1>${escapeHtml(run.sourceName)}</h1><p class="muted">${escapeHtml(run.sourceLocation)}</p></div>
    <div class="summary"><span class="pill">${escapeHtml(run.reviewPurpose ?? "content")} review</span><span class="pill">${escapeHtml(run.status)}</span><span class="pill">${run.inspectedChunkCount}/${run.candidateChunkCount} inspected</span><span class="pill critical">${run.blockingCount} blocking</span></div></div>
    <p class="muted">Parser ${escapeHtml(run.parserVersion)} · Chunker ${escapeHtml(run.chunkerVersion)} · Inspector ${escapeHtml(run.inspectorVersion)}</p>
    <h2>Flagged chunks (${model.flags.length})</h2>
    ${cards || "<p>No inspection findings.</p>"}
    ${decisionPanel}`);
}

export function renderCandidateEditor(model: DocumentReviewViewModel): string {
  const editable = model.run.status === "review_ready";
  const metadataReview = model.run.reviewPurpose === "metadata";
  const candidates = model.candidates.map((candidate) => `<section class="candidate-editor" id="${escapeHtml(candidate.id)}">
    <div class="flag-head"><strong>Chunk ${candidate.chunkIndex}</strong><span class="muted">Pages ${escapeHtml(candidate.pageNumbers.join(", "))} · ${candidate.tokenCount} tokens${candidate.sectionHeader ? ` · ${escapeHtml(candidate.sectionHeader)}` : ""}</span></div>
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

import type { ApiKeyScopeSummary } from "./api-key-scope-store.ts";

export interface ApiKeyScopeAdminViewModel {
  readonly apiKeys: readonly ApiKeyScopeSummary[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderScopeList(apiKey: ApiKeyScopeSummary): string {
  if (apiKey.tenantIds.length === 0) {
    return '<p class="muted">No AMC scopes granted.</p>';
  }
  return `<div class="scopes">${apiKey.tenantIds.map(
    (tenantId) => `<span class="scope">${escapeHtml(tenantId)}</span>`,
  ).join("")}</div>`;
}

function renderApiKey(apiKey: ApiKeyScopeSummary): string {
  const status = apiKey.isActive
    ? '<span class="status active">Active</span>'
    : '<span class="status inactive">Inactive</span>';
  return `<section class="key" id="key-${escapeHtml(apiKey.id)}">
    <div class="key-head">
      <div><h2>${escapeHtml(apiKey.name ?? "Unnamed API key")}</h2><code>${escapeHtml(apiKey.id)}</code></div>
      <div>${status}<span class="tier">${escapeHtml(apiKey.tier)}</span></div>
    </div>
    <h3>Granted AMC scopes</h3>
    ${renderScopeList(apiKey)}
    <form method="post" action="/admin/api-keys/${escapeHtml(apiKey.id)}/scopes">
      <label>AMC code
        <input name="tenantId" required maxlength="100" pattern="[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?" autocomplete="off" placeholder="e.g. 176">
      </label>
      <button type="submit">Grant AMC access</button>
    </form>
  </section>`;
}

export function renderApiKeyScopeAdmin(model: ApiKeyScopeAdminViewModel): string {
  const apiKeys = model.apiKeys.map(renderApiKey).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API key AMC access</title>
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; color: #17202a; background: #f5f7fa; }
    body { margin: 0; }
    main { max-width: 1000px; margin: 0 auto; padding: 28px 20px 60px; }
    h1 { margin-bottom: 6px; }
    h2 { margin: 0 0 5px; font-size: 18px; }
    h3 { margin: 22px 0 10px; font-size: 14px; }
    code { color: #475467; overflow-wrap: anywhere; }
    .muted { color: #667085; }
    .key { margin-top: 18px; padding: 20px; border: 1px solid #d0d5dd; border-radius: 10px; background: white; }
    .key-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
    .status, .tier, .scope { display: inline-block; border-radius: 999px; padding: 5px 9px; font-size: 13px; }
    .status { margin-right: 7px; font-weight: 600; }
    .active { color: #067647; background: #ecfdf3; }
    .inactive { color: #b42318; background: #fef3f2; }
    .tier { color: #344054; background: #f2f4f7; }
    .scopes { display: flex; flex-wrap: wrap; gap: 7px; }
    .scope { color: #1849a9; background: #eff4ff; font: 600 13px/1.2 ui-monospace, monospace; }
    form { display: flex; align-items: end; gap: 10px; margin-top: 18px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    input { min-width: 220px; padding: 9px 10px; border: 1px solid #98a2b3; border-radius: 6px; font-size: 15px; }
    button { padding: 10px 14px; border: 0; border-radius: 6px; color: white; background: #175cd3; font-weight: 600; cursor: pointer; }
    @media (max-width: 640px) { .key-head, form { align-items: stretch; flex-direction: column; } input { min-width: 0; } }
  </style>
</head>
<body><main>
  <h1>API key AMC access</h1>
  <p class="muted">Grant an existing key access to one exact AMC scope. Changes take effect immediately.</p>
  ${apiKeys || '<section class="key">No API keys found.</section>'}
</main></body>
</html>`;
}

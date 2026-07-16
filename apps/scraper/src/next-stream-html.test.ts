import { describe, expect, test } from "bun:test";

import { resolveNextStreamedHtml } from "./next-stream-html.ts";

describe("resolveNextStreamedHtml", () => {
  test("replaces a React suspense fallback with its streamed server content", () => {
    const html = `
      <html><body><main>
        <h1>Platinum Hybrid Long-Short Fund</h1>
        <template id="B:0"></template><div>Loading Fund Facts...</div>
      </main>
      <div hidden id="S:0"><section><h2>Fund Facts</h2><p>Fund manager: Mr. Gaurik Shah</p></section></div>
      <script>$RC("B:0","S:0")</script>
      </body></html>`;

    const resolved = resolveNextStreamedHtml(html);

    expect(resolved).toContain("Fund manager: Mr. Gaurik Shah");
    expect(resolved).not.toContain("Loading Fund Facts...");
    expect(resolved).not.toContain('id="S:0"');
  });

  test("leaves ordinary server-rendered HTML unchanged", () => {
    const html = "<html><body><main><h1>Fund</h1><p>Complete content.</p></main></body></html>";

    const resolved = resolveNextStreamedHtml(html);

    expect(resolved).toContain("<p>Complete content.</p>");
  });

  test("supports multiple streamed boundaries", () => {
    const html = `
      <main>
        <template id="B:1"></template><p>Loading Key Parameters...</p>
        <template id="B:2"></template><p>Loading Downloads...</p>
      </main>
      <div hidden id="S:1"><h2>Key Parameters</h2><p>Minimum investment: ₹10,00,000</p></div>
      <div hidden id="S:2"><h2>Downloads</h2><a href="/kim.pdf">KIM</a></div>
      <script>$RC("B:1","S:1")</script>
      <script>$RC("B:2","S:2")</script>`;

    const resolved = resolveNextStreamedHtml(html);

    expect(resolved).toContain("Minimum investment: ₹10,00,000");
    expect(resolved).toContain('href="/kim.pdf"');
    expect(resolved).not.toContain("Loading Key Parameters...");
    expect(resolved).not.toContain("Loading Downloads...");
  });

  test("removes stale leaf loading placeholders after streamed content resolves", () => {
    const html = `
      <main>
        <p>Loading Key Parameters...</p>
        <template id="B:0"></template><p>Loading Fund Facts...</p>
      </main>
      <div hidden id="S:0"><h2>Fund Facts</h2><p>Minimum investment: ₹10,00,000</p></div>
      <script>$RC("B:0","S:0")</script>`;

    const resolved = resolveNextStreamedHtml(html);

    expect(resolved).toContain("Minimum investment: ₹10,00,000");
    expect(resolved).not.toContain("Loading Key Parameters...");
    expect(resolved).not.toContain("Loading Fund Facts...");
  });
});

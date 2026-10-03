/**
 * Static assets of the review page view, served by the API itself (no CDN:
 * the host is internal and egress-controlled).
 *
 * - pdf.js: the pinned `pdfjs-dist` build files, verbatim, from a fixed
 *   allowlist (no path joins with request input), under a URL carrying the
 *   package version so they can be cached as immutable.
 * - the browser module (`client/page-view.client.ts`): bundled with `Bun.build`
 *   once per process on first use (memoized promise) and served under a
 *   content-hash `?v=`. pdf.js is loaded by the module at runtime from the URL
 *   in the page's data attributes, so it is not part of the bundle.
 */

import pdfjsPackage from "pdfjs-dist/package.json";

import type { PageViewAssets } from "../views.ts";

export const PDFJS_VERSION: string = pdfjsPackage.version;

const ASSET_BASE = "/review/assets";
const JS_CONTENT_TYPE = "text/javascript; charset=utf-8";
const IMMUTABLE = "private, max-age=31536000, immutable";

/** Published name -> module specifier. The only pdf.js files ever served. */
const PDFJS_FILES: ReadonlyMap<string, string> = new Map([
  ["pdf.min.mjs", "pdfjs-dist/build/pdf.min.mjs"],
  ["pdf.worker.min.mjs", "pdfjs-dist/build/pdf.worker.min.mjs"],
]);

const CLIENT_ENTRYPOINT = new URL("./client/page-view.client.ts", import.meta.url).pathname;

export interface ClientBundle {
  readonly code: string;
  /** First 16 hex chars of the bundle's sha256. */
  readonly hash: string;
}

export class ReviewAssets {
  readonly #pdfjsPaths = new Map(
    [...PDFJS_FILES].map(([name, specifier]) => [name, Bun.resolveSync(specifier, import.meta.dir)]),
  );
  #bundle: Promise<ClientBundle> | undefined;

  /** The versioned URLs the page view references. Builds the client bundle if needed. */
  async urls(): Promise<PageViewAssets> {
    const { hash } = await this.clientBundle();
    return {
      clientUrl: `${ASSET_BASE}/page-view.js?v=${hash}`,
      pdfjsUrl: `${ASSET_BASE}/pdfjs/${PDFJS_VERSION}/pdf.min.mjs`,
      pdfjsWorkerUrl: `${ASSET_BASE}/pdfjs/${PDFJS_VERSION}/pdf.worker.min.mjs`,
    };
  }

  /** The pdf.js file for an allowlisted name and the pinned version; null otherwise (404). */
  pdfjsResponse(version: string, file: string): Response | null {
    const path = version === PDFJS_VERSION ? this.#pdfjsPaths.get(file) : undefined;
    if (!path) return null;
    return new Response(Bun.file(path), { headers: jsHeaders(IMMUTABLE) });
  }

  /** Memoized: the first call starts the build, every later call shares it. A failed build is retried on the next call. */
  clientBundle(): Promise<ClientBundle> {
    if (!this.#bundle) {
      const pending = buildClientBundle();
      pending.catch(() => {
        if (this.#bundle === pending) this.#bundle = undefined;
      });
      this.#bundle = pending;
    }
    return this.#bundle;
  }

  /** The bundle; immutable caching only when `version` is the current hash. */
  async clientResponse(version: string | undefined): Promise<Response> {
    const { code, hash } = await this.clientBundle();
    return new Response(code, { headers: jsHeaders(version === hash ? IMMUTABLE : "no-cache") });
  }
}

async function buildClientBundle(): Promise<ClientBundle> {
  const result = await Bun.build({
    entrypoints: [CLIENT_ENTRYPOINT],
    target: "browser",
    format: "esm",
    minify: true,
  });
  const output = result.outputs[0];
  if (!result.success || !output) {
    throw new AggregateError(result.logs, "Review page view client bundle failed to build.");
  }
  const code = await output.text();
  const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex").slice(0, 16);
  return { code, hash };
}

function jsHeaders(cacheControl: string): HeadersInit {
  return {
    "content-type": JS_CONTENT_TYPE,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  };
}

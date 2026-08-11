import { describe, expect, test } from "bun:test";

import { createLogicalDocumentKey } from "@mf-rag/types";
import { SourceConnectorError } from "./source-connector.ts";
import { discoverSebiSidScraper } from "./sebi-sid-scraper.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  strategy: "sebi_sid_scraper" as const,
  mfId: "3",
  maxSchemes: 10,
  maxDocuments: 10,
  minimumDocuments: 1,
};

function schemeListHtml(schemeIds: string[]): string {
  const calls = schemeIds
    .map((id) => `<a href="javascript:getFundDetails('${id}')">Scheme ${id}</a>`)
    .join("\n");
  return `<html><body>${calls}</body></html>`;
}

function detailHtml(pdfPath: string): string {
  // SEBI wraps PDFs in a viewer: /web/?file=<pdf-url>
  const viewerSrc = pdfPath.startsWith("http")
    ? `https://www.sebi.gov.in/web/?file=${pdfPath}`
    : pdfPath;
  return `<html><body><iframe src='${viewerSrc}' width="100%" height="600"></iframe></body></html>`;
}

function makeFetch(
  schemeIds: string[],
  pdfPaths: Record<string, string | null>,
): (url: string, _accept: string, _signal?: AbortSignal) => Promise<string> {
  return async (url) => {
    if (url.includes("mfId=")) return schemeListHtml(schemeIds);
    const match = url.match(/mfdId=(\d+)/);
    const id = match?.[1];
    if (id) {
      const pdfPath = pdfPaths[id];
      if (pdfPath === null) return "<html><body>No document available</body></html>";
      if (pdfPath !== undefined) return detailHtml(pdfPath);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

const allowAny = (url: string) => url;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverSebiSidScraper", () => {
  test("happy path: discovers PDF for each scheme", async () => {
    const fetch = makeFetch(
      ["101", "102", "103"],
      {
        "101": "https://www.sebi.gov.in/sebi_data/docs/sid-101.pdf",
        "102": "https://www.sebi.gov.in/sebi_data/docs/sid-102.pdf",
        "103": "https://www.sebi.gov.in/sebi_data/docs/sid-103.pdf",
      },
    );

    const docs = await discoverSebiSidScraper(BASE_CONFIG, fetch, allowAny);

    expect(docs).toEqual([
      {
        logicalDocumentKey: createLogicalDocumentKey("sebi-sid:101"),
        url: "https://www.sebi.gov.in/sebi_data/docs/sid-101.pdf",
      },
      {
        logicalDocumentKey: createLogicalDocumentKey("sebi-sid:102"),
        url: "https://www.sebi.gov.in/sebi_data/docs/sid-102.pdf",
      },
      {
        logicalDocumentKey: createLogicalDocumentKey("sebi-sid:103"),
        url: "https://www.sebi.gov.in/sebi_data/docs/sid-103.pdf",
      },
    ]);
  });

  test("respects maxSchemes limit — stops parsing after limit", async () => {
    const fetchedDetailIds: string[] = [];
    const fetch = async (url: string, _accept: string) => {
      if (url.includes("mfId=")) {
        return schemeListHtml(["201", "202", "203", "204", "205"]);
      }
      const match = url.match(/mfdId=(\d+)/);
      if (match?.[1]) {
        fetchedDetailIds.push(match[1]);
        return detailHtml(`https://www.sebi.gov.in/sebi_data/docs/sid-${match[1]}.pdf`);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const docs = await discoverSebiSidScraper(
      { ...BASE_CONFIG, maxSchemes: 2, minimumDocuments: 1 },
      fetch,
      allowAny,
    );

    expect(fetchedDetailIds).toEqual(["201", "202"]);
    expect(docs).toHaveLength(2);
  });

  test("respects maxDocuments limit — stops collecting after limit", async () => {
    const fetch = makeFetch(
      ["301", "302", "303"],
      {
        "301": "https://www.sebi.gov.in/sebi_data/docs/sid-301.pdf",
        "302": "https://www.sebi.gov.in/sebi_data/docs/sid-302.pdf",
        "303": "https://www.sebi.gov.in/sebi_data/docs/sid-303.pdf",
      },
    );

    const docs = await discoverSebiSidScraper(
      { ...BASE_CONFIG, maxDocuments: 2, minimumDocuments: 1 },
      fetch,
      allowAny,
    );

    expect(docs).toHaveLength(2);
  });

  test("skips schemes with no PDF iframe and continues", async () => {
    const fetch = makeFetch(
      ["401", "402", "403"],
      {
        "401": "https://www.sebi.gov.in/sebi_data/docs/sid-401.pdf",
        "402": null,  // no iframe
        "403": "https://www.sebi.gov.in/sebi_data/docs/sid-403.pdf",
      },
    );

    const docs = await discoverSebiSidScraper(BASE_CONFIG, fetch, allowAny);

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => String(d.logicalDocumentKey))).toEqual([
      "sebi-sid:401",
      "sebi-sid:403",
    ]);
  });

  test("throws SEBI_DOCUMENT_MINIMUM when discovered count is below minimum", async () => {
    const fetch = makeFetch(
      ["501", "502"],
      {
        "501": null,
        "502": null,
      },
    );

    await expect(
      discoverSebiSidScraper({ ...BASE_CONFIG, minimumDocuments: 1 }, fetch, allowAny),
    ).rejects.toMatchObject({
      code: "SEBI_DOCUMENT_MINIMUM",
      classification: "deterministic",
    });
  });

  test("throws SEBI_DOCUMENT_MINIMUM for malformed scheme list with no getFundDetails calls", async () => {
    const fetch = async (url: string, _accept: string) => {
      if (url.includes("doGetFundDetails")) return "<html><body>Page changed</body></html>";
      throw new Error(`Unexpected URL: ${url}`);
    };

    await expect(
      discoverSebiSidScraper({ ...BASE_CONFIG, minimumDocuments: 1 }, fetch, allowAny),
    ).rejects.toMatchObject({
      code: "SEBI_DOCUMENT_MINIMUM",
      classification: "deterministic",
    });
  });

  test("converts relative PDF URL in iframe to absolute", async () => {
    const fetch = async (url: string, _accept: string) => {
      if (url.includes("doGetFundDetails") && url.includes("mfId=")) return schemeListHtml(["601"]);
      if (url.includes("mfdId=601")) {
        // Viewer URL with a relative file= param (edge case)
        return `<html><body><iframe src='https://www.sebi.gov.in/web/?file=https://www.sebi.gov.in/sebi_data/docs/sid-601.pdf'></iframe></body></html>`;
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const docs = await discoverSebiSidScraper(BASE_CONFIG, fetch, allowAny);

    expect(docs[0]?.url).toBe("https://www.sebi.gov.in/sebi_data/docs/sid-601.pdf");
  });

  test("respects AbortSignal cancellation between scheme fetches", async () => {
    const controller = new AbortController();
    let fetchCount = 0;

    const fetch = async (url: string, _accept: string) => {
      if (url.includes("mfId=")) return schemeListHtml(["701", "702", "703"]);
      fetchCount += 1;
      // Abort after first detail fetch
      if (fetchCount === 1) controller.abort();
      return detailHtml("https://www.sebi.gov.in/sebi_data/docs/sid-701.pdf");
    };

    await expect(
      discoverSebiSidScraper(
        { ...BASE_CONFIG, minimumDocuments: 1 },
        fetch,
        allowAny,
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: "FETCH_CANCELLED",
      classification: "deterministic",
    });
  });

  test("passes URL through assertAllowedDocumentUrl, propagating errors", async () => {
    const fetch = makeFetch(
      ["801"],
      { "801": "https://untrusted.example.com/sid-801.pdf" },
    );
    const assertAllowed = (url: string) => {
      if (!url.includes("sebi.gov.in")) {
        throw new SourceConnectorError("URL_HOST_NOT_ALLOWED", "deterministic", `Host not allowed: ${url}`);
      }
      return url;
    };

    await expect(
      discoverSebiSidScraper(BASE_CONFIG, fetch, assertAllowed),
    ).rejects.toMatchObject({
      code: "URL_HOST_NOT_ALLOWED",
    });
  });

  test("returns results sorted by logical document key", async () => {
    // Provide schemes in non-sorted order; expect output sorted by key
    const fetch = makeFetch(
      ["903", "901", "902"],
      {
        "901": "https://www.sebi.gov.in/sebi_data/docs/sid-901.pdf",
        "902": "https://www.sebi.gov.in/sebi_data/docs/sid-902.pdf",
        "903": "https://www.sebi.gov.in/sebi_data/docs/sid-903.pdf",
      },
    );

    const docs = await discoverSebiSidScraper(BASE_CONFIG, fetch, allowAny);

    expect(docs.map((d) => String(d.logicalDocumentKey))).toEqual([
      "sebi-sid:901",
      "sebi-sid:902",
      "sebi-sid:903",
    ]);
  });

  test("ignores non-PDF iframe sources", async () => {
    const fetch = async (url: string, _accept: string) => {
      if (url.includes("doGetFundDetails") && url.includes("mfId=")) return schemeListHtml(["1001"]);
      // iframe with a viewer URL pointing to a non-PDF
      return `<html><body><iframe src="https://www.sebi.gov.in/web/?file=https://www.sebi.gov.in/sebiweb/viewer?doc=1001"></iframe></body></html>`;
    };

    const docs = await discoverSebiSidScraper(
      { ...BASE_CONFIG, minimumDocuments: 0 },
      fetch,
      allowAny,
    );

    expect(docs).toHaveLength(0);
  });
});

import type { HtmlSourceConfig } from "../html-scraper.ts";

const BASE = "https://www.mutualfundssahihai.com";

export const amfiKnowledgeCentre: HtmlSourceConfig = {
  name: "amfi-knowledge-centre",
  contentCategory: "education",
  contentSelector: "#block-system-main, .node-content, article, .field-name-body",
  pages: [
    { url: `${BASE}/en/what-is-a-mutual-fund`, slug: "what-is-a-mutual-fund" },
    { url: `${BASE}/en/what-are-various-types-mutual-funds`, slug: "types-of-mutual-funds" },
    { url: `${BASE}/en/what-net-asset-value-nav`, slug: "what-is-nav" },
    { url: `${BASE}/en/what-are-equity-funds`, slug: "what-are-equity-funds" },
    { url: `${BASE}/en/what-are-debt-funds`, slug: "what-are-debt-funds" },
    { url: `${BASE}/en/different-types-risk-equity-funds`, slug: "risks-in-mutual-funds" },
    { url: `${BASE}/en/elss-fund-tax-saving-mutual-fund`, slug: "elss-tax-saving-funds" },
    { url: `${BASE}/en/what-are-index-funds`, slug: "what-are-index-funds" },
    { url: `${BASE}/en/low-risk-vs-high-risk-investments`, slug: "low-risk-vs-high-risk" },
    { url: `${BASE}/en/what-costs-does-one-incur-while-redeeming-mutual-fund-units`, slug: "redemption-costs" },
  ],
};

export const amfiInvestorCentre: HtmlSourceConfig = {
  name: "amfi-investor-centre",
  contentCategory: "procedural",
  contentSelector: "#block-system-main, .node-content, article, .field-name-body",
  pages: [
    { url: `${BASE}/en/what-are-different-ways-investing-mutual-funds`, slug: "how-to-invest" },
    { url: `${BASE}/en/kyc`, slug: "know-your-customer-kyc" },
    { url: `${BASE}/en/how-do-i-get-my-returns-mutual-funds`, slug: "how-to-get-returns" },
    { url: `${BASE}/en/systematic-investment-plan-sip-and-how-it-works`, slug: "sip-how-it-works" },
    { url: `${BASE}/en/what-is-sip`, slug: "what-is-sip" },
    { url: `${BASE}/en/when-should-i-start-investing-mutual-funds`, slug: "when-to-start-investing" },
    { url: `${BASE}/en/goal-planning`, slug: "goal-planning" },
    { url: `${BASE}/en/how-should-one-compare-performance-any-two-schemes`, slug: "comparing-scheme-performance" },
    { url: `${BASE}/en/why-should-one-not-be-bothered-volatility-mutual-funds`, slug: "volatility-and-mutual-funds" },
    { url: `${BASE}/en/what-happens-if-you-delay-investing`, slug: "cost-of-delay" },
  ],
};

export const allAmfiSources: HtmlSourceConfig[] = [
  amfiKnowledgeCentre,
  amfiInvestorCentre,
];

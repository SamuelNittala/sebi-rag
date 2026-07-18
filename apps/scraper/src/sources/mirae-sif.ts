import type { HtmlSourceConfig } from "../html-scraper.ts";

const MIRAE_SIF_BASE = "https://platinumsif.miraeassetmf.co.in";

export const miraeSifFund: HtmlSourceConfig = {
  name: "mirae-sif",
  contentCategory: "product",
  contentSelector: "main, #main-content",
  pages: [
    {
      url: `${MIRAE_SIF_BASE}/fund?schemeCode=3166`,
      slug: "platinum-hybrid-long-short-fund",
    },
  ],
};

// Knowledge-center blogs — SIF-domain educational content, NOT strategy
// documents (slugs carry no ISID/KIM/FAQ/pager keywords, so document scope
// classification takes the default non-strategy path).
export const miraeSifKnowledgeCenter: HtmlSourceConfig = {
  name: "mirae-sif",
  contentCategory: "education",
  contentSelector: "main, #main-content, article",
  // Explicit titles: these SPA pages render h1/<title> as the site logo text
  // ("Mirae Asset"), so extraction cannot recover the article headline.
  pages: [
    {
      url: `${MIRAE_SIF_BASE}/knowledge-center/blogs/what-is-a-specialized-investment-fund-a-beginners-guide-to-sif`,
      slug: "what-is-a-specialized-investment-fund-a-beginners-guide-to-sif",
      title: "What is a Specialized Investment Fund? A Beginner's Guide to SIF",
    },
    {
      url: `${MIRAE_SIF_BASE}/knowledge-center/blogs/sif-vs-mutual-fund-what-is-the-difference`,
      slug: "sif-vs-mutual-fund-what-is-the-difference",
      title: "SIF vs Mutual Fund: What is the Difference?",
    },
    {
      url: `${MIRAE_SIF_BASE}/knowledge-center/blogs/understanding-sif-strategies-without-jargon`,
      slug: "understanding-sif-strategies-without-jargon",
      title: "Understanding SIF Strategies Without Jargon",
    },
    {
      url: `${MIRAE_SIF_BASE}/knowledge-center/blogs/who-should-consider-sif-a-suitability-guide-for-investors`,
      slug: "who-should-consider-sif-a-suitability-guide-for-investors",
      title: "Who Should Consider SIF? A Suitability Guide for Investors",
    },
    {
      url: `${MIRAE_SIF_BASE}/knowledge-center/blogs/how-to-read-a-sif-document-before-investing`,
      slug: "how-to-read-a-sif-document-before-investing",
      title: "How to Read a SIF Document Before Investing",
    },
    {
      url: `${MIRAE_SIF_BASE}/knowledge-center/blogs/sifs-decoded-strategy-structure-and-discipline`,
      slug: "sifs-decoded-strategy-structure-and-discipline",
      title: "SIFs Decoded: Strategy, Structure and Discipline",
    },
  ],
};

// NOTE: /knowledge-center/did-you-know was attempted (2026-07-18) and dropped:
// the accordion answers do not survive Next.js stream reassembly — the scrape
// returns the 13 questions with no answer bodies. Re-attempt only if the page
// ships answers in the stream payload.

export const allMiraeSifSources: HtmlSourceConfig[] = [
  miraeSifFund,
  miraeSifKnowledgeCenter,
];

import { describe, expect, test } from "bun:test";

import {
  extractMiraeSifFaqMarkdown,
  mergeMiraeSifFaqMarkdown,
} from "./mirae-sif-extractor.ts";

describe("extractMiraeSifFaqMarkdown", () => {
  test("extracts FAQ pairs from Next.js flight data", () => {
    const flightData = `9:{"data":{"faqs":[{"question":"What is SIF?","answer":"A regulated investment product."},{"question":"Can I redeem?","answer":"Redemption is available twice weekly. #Conditions apply."}]}}`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(flightData)}])</script>`;

    const markdown = extractMiraeSifFaqMarkdown(html);

    expect(markdown).toContain("### What is SIF?");
    expect(markdown).toContain("A regulated investment product.");
    expect(markdown).toContain("### Can I redeem?");
    expect(markdown).toContain("Redemption is available twice weekly.\n\nConditions apply.");
  });

  test("skips unresolved React references rather than indexing placeholders", () => {
    const flightData = `9:{"data":{"faqs":[{"question":"How do I redeem?","answer":"$15"}]}}`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(flightData)}])</script>`;

    expect(extractMiraeSifFaqMarkdown(html)).toBe("");
  });

  test("resolves streamed Next.js text references used by long FAQ answers", () => {
    const answer = "Redemption is available twice weekly.";
    const faqFrame = `9:{"data":{"faqs":[{"question":"How do I redeem?","answer":"$15"}]}}15:T${answer.length.toString(16)},`;
    const html = [faqFrame, answer]
      .map((frame) => `<script>self.__next_f.push([1,${JSON.stringify(frame)}])</script>`)
      .join("");

    expect(extractMiraeSifFaqMarkdown(html)).toContain(answer);
  });

  test("returns empty markdown when no FAQ payload exists", () => {
    expect(extractMiraeSifFaqMarkdown("<main>No FAQs</main>")).toBe("");
  });

  test("strips a leaked flight frame from an extracted FAQ answer", () => {
    const contaminatedAnswer = 'Submit the redemption request.9:["$","$L15",null,{"data":{';
    const flightData = `9:{"data":{"faqs":[{"question":"How do I redeem?","answer":${JSON.stringify(contaminatedAnswer)}}]}}`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(flightData)}])</script>`;

    const markdown = extractMiraeSifFaqMarkdown(html);

    expect(markdown).toContain("Submit the redemption request.");
    expect(markdown).not.toContain("$L15");
  });

  test("repairs the source's split SIP question and answer fields", () => {
    const flightData = `9:{"data":{"faqs":[{"question":"What happens below the threshold?","answer":"A passive breach is allowed. #Does SIF offer SIP, SWP and STP?"},{"question":"Yes. SIP facility is available under the SIF.","answer":"The minimum threshold must be fulfilled."}]}}`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(flightData)}])</script>`;

    const markdown = extractMiraeSifFaqMarkdown(html);

    expect(markdown).toContain("### Does SIF offer SIP, SWP and STP?");
    expect(markdown).toContain("Yes. SIP facility is available under the SIF. The minimum threshold must be fulfilled.");
    expect(markdown).not.toContain("### Yes. SIP facility");
  });
});

describe("mergeMiraeSifFaqMarkdown", () => {
  test("keeps rendered FAQ answers and appends only missing flight FAQs", () => {
    const rendered = `# Fund\n\nGot Questions?\n\nWe've Got Answers!\n\n### What is SIF?\n\nRendered answer.\n\n### How to invest?\n\nRendered steps.`;
    const extracted = `### What is SIF?\n\nPayload answer.\n\n### Where is NAV?\n\nOn the website.`;

    const merged = mergeMiraeSifFaqMarkdown(rendered, extracted);

    expect(merged).toContain("## Got Questions? We've Got Answers!");
    expect(merged).toContain("Rendered answer.");
    expect(merged).not.toContain("Payload answer.");
    expect(merged).toContain("### Where is NAV?");
  });

  test("removes a leaked Next.js flight frame and restores later extracted FAQs", () => {
    const rendered = `# Fund\n\nGot Questions?\n\nWe've Got Answers!\n\n### How do I redeem?\n\nSubmit the redemption request.9:["$","$L15",null,{"data":{`;
    const extracted = `### How do I redeem?\n\nSubmit the redemption request.9:["$","$L15",null,{"data":{\n\n### What is the derivatives limit?\n\nUp to 25% of net assets.`;

    const merged = mergeMiraeSifFaqMarkdown(rendered, extracted);

    expect(merged).toContain("Submit the redemption request.");
    expect(merged).not.toContain('$L15');
    expect(merged).toContain("### What is the derivatives limit?");
  });
});

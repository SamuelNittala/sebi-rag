import { describe, expect, test } from "bun:test";

import { createTenantId } from "@mf-rag/types";
import { createApiKeyId } from "./api-key-scope-store.ts";
import { renderApiKeyScopeAdmin } from "./views.ts";

describe("API key scope admin rendering", () => {
  test("shows API keys, their exact AMC grants, and an add-scope form", () => {
    const html = renderApiKeyScopeAdmin({
      apiKeys: [{
        id: createApiKeyId("73d13d16-6735-4203-a3ba-16ce14a53097"),
        name: "investor-agent-uat-all-amc-2026-07-31",
        tier: "free",
        isActive: true,
        tenantIds: [createTenantId("176"), createTenantId("910")],
      }],
    });

    expect(html).toContain("API key AMC access");
    expect(html).toContain("investor-agent-uat-all-amc-2026-07-31");
    expect(html).toContain("176");
    expect(html).toContain("910");
    expect(html).toContain('name="tenantId"');
    expect(html).toContain(
      'action="/admin/api-keys/73d13d16-6735-4203-a3ba-16ce14a53097/scopes"',
    );
  });

  test("escapes stored labels and identifies inactive keys", () => {
    const html = renderApiKeyScopeAdmin({
      apiKeys: [{
        id: createApiKeyId("73d13d16-6735-4203-a3ba-16ce14a53097"),
        name: "<script>alert(1)</script>",
        tier: "free",
        isActive: false,
        tenantIds: [],
      }],
    });

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Inactive");
    expect(html).toContain("No AMC scopes granted.");
  });
});

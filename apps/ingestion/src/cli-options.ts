import {
  assertClassifiedKnowledgeOwnership,
  createTenantId,
  type ClassifiedKnowledgeOwnership,
} from "@mf-rag/types";

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseSourceUrlOption(args: string[]): string | undefined {
  let value: string | undefined;
  try {
    value = optionValue(args, "--source-url");
  } catch {
    throw new Error("--source-url requires an absolute HTTP(S) URL");
  }
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--source-url requires an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("--source-url requires an absolute HTTP(S) URL");
  }
  return parsed.toString();
}

export interface TrustedOwnershipEnvironment {
  readonly INGEST_VISIBILITY_SCOPE?: string;
  readonly OWNERSHIP_MANIFEST_ID?: string;
  readonly OWNERSHIP_MANIFEST_VERSION?: string;
  readonly AMC_SCOPE?: string;
}

export function parseTrustedOwnershipOptions(
  args: string[],
  environment: TrustedOwnershipEnvironment = process.env as TrustedOwnershipEnvironment,
): ClassifiedKnowledgeOwnership {
  const visibilityScope = optionValue(args, "--visibility-scope")
    ?? environment.INGEST_VISIBILITY_SCOPE;
  if (visibilityScope !== "GLOBAL" && visibilityScope !== "TENANT") {
    throw new Error("Trusted --visibility-scope must be GLOBAL or TENANT.");
  }

  const ownershipManifestId = (
    optionValue(args, "--ownership-manifest-id")
      ?? environment.OWNERSHIP_MANIFEST_ID
      ?? ""
  ).trim();
  const manifestVersionValue = optionValue(args, "--ownership-manifest-version")
    ?? environment.OWNERSHIP_MANIFEST_VERSION;
  const ownershipManifestVersion = Number(manifestVersionValue);
  const tenantId = visibilityScope === "GLOBAL"
    ? null
    : canonicalTenantScope(environment.AMC_SCOPE);
  const ownership = {
    visibilityScope,
    tenantId,
    ownershipManifestId,
    ownershipManifestVersion,
  } as ClassifiedKnowledgeOwnership;
  assertClassifiedKnowledgeOwnership(ownership);
  return ownership;
}

function canonicalTenantScope(value: string | undefined): string {
  if (!value) {
    throw new Error("TENANT ownership requires protected AMC_SCOPE.");
  }
  try {
    return createTenantId(value);
  } catch {
    throw new Error("TENANT ownership requires a canonical AMC_SCOPE.");
  }
}

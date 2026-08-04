import { resolve } from "node:path";

import type { DesiredSourceRegistry } from "@mf-rag/types";
import { loadAccessScopeManifests } from "../apps/pipeline/src/config/access-scope-manifest.ts";

type Reconcile = (desired: DesiredSourceRegistry) => Promise<unknown>;

export async function syncSourceRegistryFromDirectory(
  directory: string | URL,
  reconcile: Reconcile,
): Promise<unknown> {
  // Loading parses every file and validates cross-file uniqueness before the
  // callback can open a transaction.
  const desired = await loadAccessScopeManifests(directory);
  return reconcile(desired);
}

function directoryArgument(args: readonly string[]): string {
  const flagIndex = args.indexOf("--directory");
  if (flagIndex === -1) return resolve("config/access-scopes");
  const directory = args[flagIndex + 1];
  if (!directory) throw new Error("--directory requires a path.");
  return resolve(directory);
}

if (import.meta.main) {
  const directory = directoryArgument(process.argv.slice(2));
  const { db, reconcileSourceRegistry } = await import("@mf-rag/db");
  const result = await syncSourceRegistryFromDirectory(
    directory,
    (desired) => reconcileSourceRegistry(db, desired),
  );
  console.log(JSON.stringify(result));
}

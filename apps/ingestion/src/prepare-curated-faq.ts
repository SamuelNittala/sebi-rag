import { prepareCuratedFaqSource } from "./orchestrator/prepare-curated-faq.ts";

function selectedSourceIds(args: string[]): string[] {
  const ids: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--source") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--source requires a manifest source ID.");
      }
      ids.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (ids.length === 0) {
    throw new Error(
      "Select curated manifest entries explicitly with --source <source-id>.",
    );
  }
  return [...new Set(ids)];
}

const sourceIds = selectedSourceIds(Bun.argv.slice(2));
let blocked = false;
for (const sourceId of sourceIds) {
  const prepared = await prepareCuratedFaqSource(sourceId);
  console.log(JSON.stringify({
    sourceId,
    sha256: prepared.source.sha256,
    artifactReused: prepared.artifactReused,
    questionCount: prepared.parse.items.length,
    chunkCount: prepared.chunks.totalChunks,
    reviewReady: prepared.parse.reviewReady,
    blockerCount: prepared.parse.blockers.length,
    warningCount: prepared.parse.warnings.length,
    markdownPreviewPath: prepared.markdownPreviewPath,
    chunkManifestPath: prepared.chunkManifestPath,
  }));
  blocked ||= !prepared.parse.reviewReady;
}
if (blocked) process.exit(2);

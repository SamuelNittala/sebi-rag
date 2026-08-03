import {
  prepareCuratedFaqSource,
  stagePreparedCuratedFaqReview,
} from "./orchestrator/prepare-curated-faq.ts";

function parseArgs(args: string[]): { sourceIds: string[]; stageReview: boolean } {
  const ids: string[] = [];
  let stageReview = false;
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
    if (args[index] === "--stage-review") {
      stageReview = true;
      continue;
    }
    throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (ids.length === 0) {
    throw new Error(
      "Select curated manifest entries explicitly with --source <source-id>.",
    );
  }
  return { sourceIds: [...new Set(ids)], stageReview };
}

const { sourceIds, stageReview } = parseArgs(Bun.argv.slice(2));
let blocked = false;
for (const sourceId of sourceIds) {
  const prepared = await prepareCuratedFaqSource(sourceId);
  const reviewRun = stageReview && prepared.parse.reviewReady
    ? await stagePreparedCuratedFaqReview(prepared)
    : null;
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
    reviewRunId: reviewRun?.id ?? null,
  }));
  blocked ||= !prepared.parse.reviewReady;
}
if (blocked) process.exit(2);

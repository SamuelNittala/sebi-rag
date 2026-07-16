#!/usr/bin/env bun

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const runId = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  const actor = optionValue("--actor");
  if (!runId || !actor) {
    console.error("Usage: bun run review:publish <review-run-id> --actor <reviewer-name>");
    process.exit(1);
  }

  const { publishApprovedReviewRun } = await import(
    "../apps/ingestion/src/review/review-publisher.ts"
  );
  const published = await publishApprovedReviewRun(runId, {
    actor,
    ollamaUrl: optionValue("--ollama") ?? process.env.OLLAMA_BASE_URL,
    embeddingBatchSize: Number(optionValue("--batch-size") ?? 10),
    onProgress: (progress) => {
      console.log(
        `[${progress.stage}] ${progress.completed}/${progress.total}`,
      );
    },
  });
  console.log(`Published ${published.sourceName} (${published.candidateChunkCount} chunks).`);
}

await main();

const DEFAULT_DENSE_SCORE_THRESHOLD = 0.3;

export function resolveDenseScoreThreshold(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_DENSE_SCORE_THRESHOLD;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_DENSE_SCORE_THRESHOLD;
}

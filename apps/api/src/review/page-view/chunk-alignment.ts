/**
 * Order-preserving join of review candidates to Docling wire chunks.
 *
 * `candidate.chunkIndex === wire.chunkIndex` does not hold in general:
 * `removeDisposableSifChunks` (collection `mirae_sif`) drops and re-numbers
 * chunks, and the Addendum path replaces Docling chunks with `addendum-v1`
 * chunks. So a candidate may pair with a wire chunk only when
 * - `metadata.parser === "docling"`, and
 * - `metadata.sourceItemRefs` equals `wire.itemRefs` and `pageNumbers` equals `wire.pages`
 *   (element-wise, same order).
 *
 * Both lists are walked in chunk-index order and pairs never cross (the
 * candidates of a Docling run are an ordered subsequence of the wire chunks,
 * since every known filter preserves order). Among the non-crossing pairings
 * with the most pairs, the one with the most text agreements wins (wire text
 * contained in the candidate text: candidate text is scheme + headings + wire
 * text unless edited/curated), then the most identical chunk indexes. This
 * resolves runs of chunks sharing one item ref and page (row-split tables such
 * as SIP pages 103/104) when one of them was dropped.
 *
 * Callers pass one page's candidates and wire chunks (both filtered to the
 * page), which keeps the dynamic programme small (tens of rows).
 */

/** The candidate fields the alignment reads (a `chunk_candidates` row satisfies it). */
export interface AlignableCandidate {
  readonly chunkIndex: number;
  readonly text: string;
  readonly pageNumbers: readonly number[];
  /** Read as `{ parser?, sourceItemRefs? }`; anything else counts as non-Docling. */
  readonly metadata: unknown;
}

/** The wire fields the alignment reads (a `DoclingWireChunk` satisfies it). */
export interface AlignableWireChunk {
  readonly chunkIndex: number;
  readonly text: string;
  readonly pages: readonly number[];
  readonly itemRefs: readonly string[];
}

export interface AlignedPair<C, W> {
  readonly candidate: C;
  readonly wire: W;
}

export interface ChunkAlignment<C, W> {
  /** In chunk-index order (of both sides). */
  readonly pairs: readonly AlignedPair<C, W>[];
  /** Candidates with no Docling geometry (addendum, edited refs, fallback), in chunk-index order. */
  readonly unmatchedCandidates: readonly C[];
  /** Wire chunks no candidate maps to (filtered out of the run), in chunk-index order. */
  readonly unmatchedWire: readonly W[];
}

/** Whether a candidate may pair with a wire chunk (parser, item refs and pages). */
export function isCompatible(candidate: AlignableCandidate, wire: AlignableWireChunk): boolean {
  const metadata = candidate.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const { parser, sourceItemRefs } = metadata as { parser?: unknown; sourceItemRefs?: unknown };
  return parser === "docling"
    && Array.isArray(sourceItemRefs)
    && sameSequence(sourceItemRefs, wire.itemRefs)
    && sameSequence(candidate.pageNumbers, wire.pages);
}

/** Inputs are sorted by chunkIndex internally; the inputs are not mutated. */
export function alignCandidatesToWire<C extends AlignableCandidate, W extends AlignableWireChunk>(
  candidates: readonly C[],
  wireChunks: readonly W[],
): ChunkAlignment<C, W> {
  const left = [...candidates].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const right = [...wireChunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const rows = left.length;
  const columns = right.length;
  // Lexicographic objective (pairs, text agreements, equal indexes) as one number:
  // a pair is worth more than all tie-breakers of every possible pairing together.
  const pairWeight = 4 * (Math.min(rows, columns) + 1);
  const weight = (candidate: C, wire: W): number => isCompatible(candidate, wire)
    ? pairWeight + (candidate.text.includes(wire.text) ? 2 : 0) + (candidate.chunkIndex === wire.chunkIndex ? 1 : 0)
    : 0;

  // score[i][j]: best objective for left[0..i) and right[0..j).
  const score = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= columns; j += 1) {
      const pair = weight(left[i - 1]!, right[j - 1]!);
      score[i]![j] = Math.max(
        score[i - 1]![j]!,
        score[i]![j - 1]!,
        pair > 0 ? score[i - 1]![j - 1]! + pair : 0,
      );
    }
  }

  const pairs: AlignedPair<C, W>[] = [];
  const pairedLeft = new Set<number>();
  const pairedRight = new Set<number>();
  for (let i = rows, j = columns; i > 0 && j > 0;) {
    const pair = weight(left[i - 1]!, right[j - 1]!);
    if (pair > 0 && score[i]![j] === score[i - 1]![j - 1]! + pair) {
      pairs.push({ candidate: left[i - 1]!, wire: right[j - 1]! });
      pairedLeft.add(i - 1);
      pairedRight.add(j - 1);
      i -= 1;
      j -= 1;
    } else if (score[i]![j] === score[i - 1]![j]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return {
    pairs: pairs.reverse(),
    unmatchedCandidates: left.filter((_, index) => !pairedLeft.has(index)),
    unmatchedWire: right.filter((_, index) => !pairedRight.has(index)),
  };
}

function sameSequence(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

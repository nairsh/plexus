/**
 * Shared vector-math utilities used by both the memory and knowledge modules.
 */

/**
 * Cosine similarity between two numeric vectors.
 * Returns -1 for invalid inputs (empty, mismatched length, or zero-norm vectors).
 */
export const cosineSimilarity = (left: number[], right: number[]): number => {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return -1;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

/** Minimum cosine-similarity threshold for memory recall to surface a match. */
export const MIN_MEMORY_SIMILARITY = 0.4;

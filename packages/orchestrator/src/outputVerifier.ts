/**
 * Centralized output verification for subagent and workflow outputs.
 *
 * Prevents false-success states by rejecting outputs that are empty,
 * refusal-only, or placeholder filler. Heuristics are intentionally tight
 * and conservative — they only fire on short outputs to avoid false positives
 * on longer content that happens to contain a matching phrase.
 */

// ── Public types ─────────────────────────────────────────────────────────────

export interface OutputVerificationResult {
  /** Whether the output is considered usable. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
}

// ── Refusal detection ────────────────────────────────────────────────────────

/**
 * Patterns that indicate a pure refusal with no usable content.
 * Only tested against outputs ≤ 500 characters to avoid false positives
 * on longer responses that may contain a refusal phrase incidentally.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  /^i(?:'m| am) (?:sorry|unable|not able)\b/,
  /^(?:sorry|apologies),? (?:i |but )\b/,
  /^i (?:can(?:'t|not)|cannot) (?:do|help|assist|provide|complete|fulfill)\b/,
  /^(?:unfortunately|regrettably),? i (?:can(?:'t|not)|cannot|am (?:unable|not able))\b/,
  /^this (?:is |goes )?(?:beyond|outside) (?:my|the)\b/,
  /^i (?:don't|do not) have (?:the )?(?:ability|capability|capacity)\b/,
];

const REFUSAL_MAX_LENGTH = 500;

function isRefusalOnly(lower: string, length: number): boolean {
  if (length > REFUSAL_MAX_LENGTH) return false;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(lower));
}

// ── Placeholder / filler detection ───────────────────────────────────────────

/**
 * Patterns that match trivially useless "output" such as placeholders or
 * stub text. Only tested against outputs ≤ 200 characters.
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^(?:todo|tbd|placeholder|coming soon|not yet implemented|work in progress)\.?$/,
  /^\[?(?:todo|tbd|placeholder|insert .+ here|your .+ here)\]?\.?$/,
  /^\.{3,}$/, // just ellipsis dots
  /^(?:n\/a|none|null|undefined|nothing|no output|no result)\.?$/,
];

const PLACEHOLDER_MAX_LENGTH = 200;

function isPlaceholderFiller(lower: string, length: number): boolean {
  if (length > PLACEHOLDER_MAX_LENGTH) return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(lower));
}

// ── Main verifier ────────────────────────────────────────────────────────────

/**
 * Verify that an output string is meaningfully usable.
 *
 * Returns `{ valid: true }` when the output passes all checks, or
 * `{ valid: false, reason }` with a traceable reason string when it does not.
 *
 * This function is deliberately stateless and provider-agnostic — it never
 * makes network calls or inspects model metadata.
 */
export function verifyOutput(output: unknown): OutputVerificationResult {
  if (typeof output !== 'string') {
    return { valid: false, reason: 'Output is not a string' };
  }

  const trimmed = output.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: 'Output is empty or whitespace-only' };
  }

  const lower = trimmed.toLowerCase();

  if (isRefusalOnly(lower, trimmed.length)) {
    return { valid: false, reason: 'Output appears to be a refusal without usable content' };
  }

  if (isPlaceholderFiller(lower, trimmed.length)) {
    return { valid: false, reason: 'Output appears to be placeholder or filler text without usable content' };
  }

  return { valid: true };
}

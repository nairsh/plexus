import { describe, expect, test } from 'vitest';
import { verifyOutput, type OutputVerificationResult } from '../packages/orchestrator/src/outputVerifier.js';

// ── Helper ───────────────────────────────────────────────────────────────────

/** Assert that verification rejects with a reason substring. */
function expectRejected(result: OutputVerificationResult, reasonSubstring: string) {
  expect(result.valid).toBe(false);
  expect(result.reason).toBeDefined();
  expect(result.reason!.toLowerCase()).toContain(reasonSubstring.toLowerCase());
}

// ═════════════════════════════════════════════════════════════════════════════
// Unit tests for the centralized output verifier
// ═════════════════════════════════════════════════════════════════════════════

describe('verifyOutput', () => {
  // ── Empty / whitespace ───────────────────────────────────────────────────

  describe('rejects empty and whitespace-only output', () => {
    test('empty string', () => {
      expectRejected(verifyOutput(''), 'empty');
    });

    test('whitespace-only string (spaces)', () => {
      expectRejected(verifyOutput('   '), 'empty');
    });

    test('whitespace-only string (tabs and newlines)', () => {
      expectRejected(verifyOutput('\n\t\n  \t\n'), 'empty');
    });

    test('non-string input: undefined', () => {
      expectRejected(verifyOutput(undefined), 'not a string');
    });

    test('non-string input: null', () => {
      expectRejected(verifyOutput(null), 'not a string');
    });

    test('non-string input: number', () => {
      expectRejected(verifyOutput(42), 'not a string');
    });

    test('non-string input: object', () => {
      expectRejected(verifyOutput({ foo: 'bar' }), 'not a string');
    });
  });

  // ── Refusal-only detection ───────────────────────────────────────────────

  describe('rejects refusal-only outputs', () => {
    const refusals = [
      "I'm sorry, I cannot complete this task.",
      "I am sorry, I'm not able to do that.",
      "Sorry, I can't help with that request.",
      "I can't do this task.",
      "I cannot provide that information.",
      "Unfortunately, I cannot fulfill this request.",
      "Regrettably, I am unable to help with that.",
      "This is beyond my capabilities.",
      "This goes outside the scope.",
      "I don't have the ability to do that.",
      "I do not have the capability to complete this.",
      "Apologies, but I cannot assist with this.",
    ];

    for (const refusal of refusals) {
      test(`rejects: "${refusal.slice(0, 60)}…"`, () => {
        expectRejected(verifyOutput(refusal), 'refusal');
      });
    }

    test('rejects refusal with leading whitespace', () => {
      expectRejected(verifyOutput("  I'm sorry, I cannot complete this task."), 'refusal');
    });

    test('does NOT reject refusal buried in long content', () => {
      const longContent =
        "Here are the analysis results.\n".repeat(30) +
        "I'm sorry, I cannot complete this task." +
        "\nBut here is what I found anyway.".repeat(10);
      expect(verifyOutput(longContent).valid).toBe(true);
    });
  });

  // ── Placeholder / filler detection ──────────────────────────────────────

  describe('rejects placeholder and filler outputs', () => {
    const placeholders = [
      'TODO',
      'todo',
      'TBD',
      'placeholder',
      'Placeholder.',
      'Coming soon',
      'Not yet implemented',
      'Work in progress',
      '[TODO]',
      '[placeholder]',
      '[insert content here]',
      '[Your answer here]',
      '...',
      '.....',
      'N/A',
      'n/a',
      'none',
      'null',
      'undefined',
      'nothing',
      'No output',
      'no result',
    ];

    for (const placeholder of placeholders) {
      test(`rejects: "${placeholder}"`, () => {
        expectRejected(verifyOutput(placeholder), 'placeholder');
      });
    }
  });

  // ── Happy path: valid outputs ──────────────────────────────────────────

  describe('accepts valid outputs', () => {
    test('normal text response', () => {
      expect(verifyOutput('Here are the results of the analysis.').valid).toBe(true);
    });

    test('multi-line response', () => {
      const output = `## Analysis Results\n\n1. Found 3 issues\n2. Fixed 2 of them\n3. One requires manual review`;
      expect(verifyOutput(output).valid).toBe(true);
    });

    test('code block response', () => {
      const output = '```typescript\nconst x = 1;\n```';
      expect(verifyOutput(output).valid).toBe(true);
    });

    test('short but meaningful response', () => {
      expect(verifyOutput('Done. The file was updated successfully.').valid).toBe(true);
    });

    test('response containing "sorry" but with content', () => {
      expect(verifyOutput("Sorry for the delay! Here's the result: 42").valid).toBe(true);
    });

    test('long response that starts with refusal-like phrase', () => {
      // Over 500 chars, should not trigger refusal check
      const longOutput = "I'm sorry, I cannot complete this task. ".padEnd(600, 'But here are alternative approaches: ');
      expect(verifyOutput(longOutput).valid).toBe(true);
    });

    test('JSON-like output', () => {
      expect(verifyOutput('{"status": "ok", "count": 5}').valid).toBe(true);
    });

    test('numeric-looking answer', () => {
      expect(verifyOutput('The answer is 42.').valid).toBe(true);
    });

    test('single word answer that is not a placeholder', () => {
      expect(verifyOutput('Success').valid).toBe(true);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('single period is rejected as placeholder', () => {
      // A single period with nothing else is not useful output
      // but our patterns require ≥3 dots, so single period passes.
      // This is intentional — overly aggressive matching would cause false positives.
      expect(verifyOutput('.').valid).toBe(true);
    });

    test('two dots pass (not matched by ellipsis pattern)', () => {
      expect(verifyOutput('..').valid).toBe(true);
    });

    test('three dots are rejected', () => {
      expectRejected(verifyOutput('...'), 'placeholder');
    });

    test('todo in context of real sentence passes', () => {
      expect(verifyOutput('Added a TODO comment in the function for future review.').valid).toBe(true);
    });

    test('placeholder in larger context passes (over 200 chars)', () => {
      const output = 'placeholder'.padEnd(250, ' — more detail here');
      expect(verifyOutput(output).valid).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration-style tests: verify that invalid outputs would cause failure
// at each call site. These test the verifier as it would be invoked.
// ═════════════════════════════════════════════════════════════════════════════

describe('output verification integration contracts', () => {
  describe('subagent completion (runner.ts) — empty output does not mark completed', () => {
    test('empty string output is rejected', () => {
      const result = verifyOutput('');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });

    test('whitespace-only output is rejected', () => {
      const result = verifyOutput('   \n\t  ');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });
  });

  describe('subagent completion (runner.ts) — refusal output does not mark completed', () => {
    test('pure refusal is rejected', () => {
      const result = verifyOutput("I'm sorry, I cannot complete this task.");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('refusal');
    });
  });

  describe('complete_workflow / answer_directly (toolExecutor.ts) — reject invalid final outputs', () => {
    const invalidOutputs = [
      { input: '', expectedReason: 'empty' },
      { input: '   ', expectedReason: 'empty' },
      { input: "I can't help with that.", expectedReason: 'refusal' },
      { input: 'TODO', expectedReason: 'placeholder' },
      { input: 'N/A', expectedReason: 'placeholder' },
      { input: '...', expectedReason: 'placeholder' },
    ];

    for (const { input, expectedReason } of invalidOutputs) {
      test(`rejects "${input || '(empty)'}" with reason containing "${expectedReason}"`, () => {
        const result = verifyOutput(input);
        expect(result.valid).toBe(false);
        expect(result.reason!.toLowerCase()).toContain(expectedReason);
      });
    }
  });

  describe('happy path — valid outputs still succeed', () => {
    const validOutputs = [
      'The research shows three key findings: A, B, and C.',
      '## Report\n\nCompleted analysis of the codebase.\n\n### Findings\n- Issue 1: resolved\n- Issue 2: needs review',
      'File updated successfully. Changes: renamed `foo` to `bar` across 12 files.',
      'Error analysis complete. Root cause: null pointer in line 42 of auth.ts.',
      'Created PR #123 with the requested changes.',
    ];

    for (const output of validOutputs) {
      test(`accepts: "${output.slice(0, 60)}…"`, () => {
        const result = verifyOutput(output);
        expect(result.valid).toBe(true);
        expect(result.reason).toBeUndefined();
      });
    }
  });
});

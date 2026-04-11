import { describe, expect, test } from 'vitest';
import {
  validateWorkItemGraph,
  formatGraphErrors,
  type GraphNode,
  type GraphValidationResult,
} from '../packages/orchestrator/src/validateWorkItemGraph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build a GraphNode. */
const node = (id: string, dependsOn: string[] = []): GraphNode => ({
  id,
  dependsOn,
});

/** Assert result is valid with zero errors. */
const expectValid = (result: GraphValidationResult) => {
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
};

/** Assert result is invalid and contains at least one error of the given type. */
const expectErrorOfType = (
  result: GraphValidationResult,
  type: string,
) => {
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.type === type)).toBe(true);
};

// ---------------------------------------------------------------------------
// Valid acyclic plans
// ---------------------------------------------------------------------------

describe('valid acyclic plans', () => {
  test('empty graph is valid', () => {
    expectValid(validateWorkItemGraph([]));
  });

  test('single node with no dependencies', () => {
    expectValid(validateWorkItemGraph([node('a')]));
  });

  test('two independent nodes', () => {
    expectValid(validateWorkItemGraph([node('a'), node('b')]));
  });

  test('simple chain: a → b → c', () => {
    expectValid(
      validateWorkItemGraph([
        node('a'),
        node('b', ['a']),
        node('c', ['b']),
      ]),
    );
  });

  test('diamond DAG: a → b, a → c, b → d, c → d', () => {
    expectValid(
      validateWorkItemGraph([
        node('a'),
        node('b', ['a']),
        node('c', ['a']),
        node('d', ['b', 'c']),
      ]),
    );
  });

  test('wide fan-out: single root with many dependents', () => {
    const root = node('root');
    const children = Array.from({ length: 10 }, (_, i) =>
      node(`child-${i}`, ['root']),
    );
    expectValid(validateWorkItemGraph([root, ...children]));
  });

  test('wide fan-in: many roots converging on a single node', () => {
    const roots = Array.from({ length: 5 }, (_, i) => node(`root-${i}`));
    const sink = node('sink', roots.map((r) => r.id));
    expectValid(validateWorkItemGraph([...roots, sink]));
  });

  test('complex valid DAG with multiple layers', () => {
    expectValid(
      validateWorkItemGraph([
        node('setup'),
        node('build-frontend', ['setup']),
        node('build-backend', ['setup']),
        node('test-frontend', ['build-frontend']),
        node('test-backend', ['build-backend']),
        node('integration-test', ['test-frontend', 'test-backend']),
        node('deploy', ['integration-test']),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate IDs
// ---------------------------------------------------------------------------

describe('duplicate IDs', () => {
  test('detects two nodes with the same ID', () => {
    const result = validateWorkItemGraph([node('a'), node('a')]);
    expectErrorOfType(result, 'duplicate_id');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskIds).toEqual(['a']);
  });

  test('detects multiple distinct duplicates', () => {
    const result = validateWorkItemGraph([
      node('a'),
      node('b'),
      node('a'),
      node('b'),
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.filter((e) => e.type === 'duplicate_id')).toHaveLength(2);
  });

  test('duplicate IDs prevent further checks (no false cycle errors)', () => {
    // With duplicates, the graph is ambiguous — only duplicate errors reported.
    const result = validateWorkItemGraph([
      node('a', ['b']),
      node('a', ['b']),
      node('b'),
    ]);
    expect(result.errors.every((e) => e.type === 'duplicate_id')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-dependencies
// ---------------------------------------------------------------------------

describe('self-dependencies', () => {
  test('detects direct self-dependency', () => {
    const result = validateWorkItemGraph([node('a', ['a'])]);
    expectErrorOfType(result, 'self_dependency');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskIds).toEqual(['a']);
  });

  test('detects self-dependency mixed with valid dependencies', () => {
    const result = validateWorkItemGraph([
      node('a'),
      node('b', ['a', 'b']),
    ]);
    expectErrorOfType(result, 'self_dependency');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskIds).toEqual(['b']);
  });

  test('multiple nodes with self-dependencies', () => {
    const result = validateWorkItemGraph([
      node('a', ['a']),
      node('b', ['b']),
    ]);
    expect(result.errors.filter((e) => e.type === 'self_dependency')).toHaveLength(2);
  });

  test('self-dependency does not prevent cycle detection', () => {
    // Self-dep on 'a' + cycle between b and c
    const result = validateWorkItemGraph([
      node('a', ['a']),
      node('b', ['c']),
      node('c', ['b']),
    ]);
    expect(result.errors.some((e) => e.type === 'self_dependency')).toBe(true);
    expect(result.errors.some((e) => e.type === 'dependency_cycle')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dangling dependencies
// ---------------------------------------------------------------------------

describe('dangling dependencies', () => {
  test('detects reference to non-existent task', () => {
    const result = validateWorkItemGraph([node('a', ['missing'])]);
    expectErrorOfType(result, 'dangling_dependency');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskIds).toEqual(['a', 'missing']);
  });

  test('detects multiple dangling references on one node', () => {
    const result = validateWorkItemGraph([
      node('a', ['missing-1', 'missing-2']),
    ]);
    expect(result.errors.filter((e) => e.type === 'dangling_dependency')).toHaveLength(2);
  });

  test('dangling deps across multiple nodes', () => {
    const result = validateWorkItemGraph([
      node('a', ['x']),
      node('b', ['y']),
    ]);
    expect(result.errors.filter((e) => e.type === 'dangling_dependency')).toHaveLength(2);
  });

  test('mixed valid and dangling dependencies', () => {
    const result = validateWorkItemGraph([
      node('a'),
      node('b', ['a', 'ghost']),
    ]);
    expectErrorOfType(result, 'dangling_dependency');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('ghost');
  });

  test('dangling deps prevent cycle detection (graph is incomplete)', () => {
    // b → c → b would be a cycle, but c depends on 'missing' which is dangling.
    // Cycle detection is skipped because the graph is incomplete.
    const result = validateWorkItemGraph([
      node('b', ['c']),
      node('c', ['b', 'missing']),
    ]);
    expect(result.errors.some((e) => e.type === 'dangling_dependency')).toBe(true);
    expect(result.errors.some((e) => e.type === 'dependency_cycle')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dependency cycles
// ---------------------------------------------------------------------------

describe('dependency cycles', () => {
  test('detects simple two-node cycle: a ↔ b', () => {
    const result = validateWorkItemGraph([
      node('a', ['b']),
      node('b', ['a']),
    ]);
    expectErrorOfType(result, 'dependency_cycle');
    expect(result.errors[0].taskIds).toContain('a');
    expect(result.errors[0].taskIds).toContain('b');
  });

  test('detects three-node cycle: a → b → c → a', () => {
    const result = validateWorkItemGraph([
      node('a', ['c']),
      node('b', ['a']),
      node('c', ['b']),
    ]);
    expectErrorOfType(result, 'dependency_cycle');
    const cycleIds = result.errors.find((e) => e.type === 'dependency_cycle')!.taskIds;
    expect(cycleIds).toHaveLength(3);
    expect(cycleIds).toContain('a');
    expect(cycleIds).toContain('b');
    expect(cycleIds).toContain('c');
  });

  test('cycle with non-cyclic nodes attached', () => {
    // root → a → b → c → a  (cycle: a,b,c; root is not in cycle)
    const result = validateWorkItemGraph([
      node('root'),
      node('a', ['root', 'c']),
      node('b', ['a']),
      node('c', ['b']),
    ]);
    expectErrorOfType(result, 'dependency_cycle');
    const cycleIds = result.errors.find((e) => e.type === 'dependency_cycle')!.taskIds;
    expect(cycleIds).toContain('a');
    expect(cycleIds).toContain('b');
    expect(cycleIds).toContain('c');
    expect(cycleIds).not.toContain('root');
  });

  test('two independent cycles in one graph', () => {
    const result = validateWorkItemGraph([
      node('a', ['b']),
      node('b', ['a']),
      node('x', ['y']),
      node('y', ['x']),
    ]);
    expectErrorOfType(result, 'dependency_cycle');
    const cycleError = result.errors.find((e) => e.type === 'dependency_cycle')!;
    // All four nodes are in cycles (reported as one combined error)
    expect(cycleError.taskIds).toHaveLength(4);
  });

  test('long cycle: 10 nodes forming a ring', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const nodes = ids.map((id, i) => node(id, [ids[(i + 1) % ids.length]]));
    const result = validateWorkItemGraph(nodes);
    expectErrorOfType(result, 'dependency_cycle');
    expect(result.errors.find((e) => e.type === 'dependency_cycle')!.taskIds).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// formatGraphErrors
// ---------------------------------------------------------------------------

describe('formatGraphErrors', () => {
  test('returns empty string for no errors', () => {
    expect(formatGraphErrors([])).toBe('');
  });

  test('returns single error message as-is', () => {
    const result = validateWorkItemGraph([node('a', ['a'])]);
    expect(formatGraphErrors(result.errors)).toBe(result.errors[0].message);
  });

  test('formats multiple errors with numbering', () => {
    const result = validateWorkItemGraph([
      node('a', ['a']),
      node('b', ['b']),
    ]);
    const formatted = formatGraphErrors(result.errors);
    expect(formatted).toContain('1.');
    expect(formatted).toContain('2.');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('node with empty dependsOn array is valid', () => {
    expectValid(validateWorkItemGraph([node('a', [])]));
  });

  test('node depending on multiple valid nodes', () => {
    expectValid(
      validateWorkItemGraph([
        node('a'),
        node('b'),
        node('c'),
        node('d', ['a', 'b', 'c']),
      ]),
    );
  });

  test('duplicate dependency references are tolerated (not an error)', () => {
    // Same dep listed twice — not ideal but not a structural graph error.
    expectValid(
      validateWorkItemGraph([node('a'), node('b', ['a', 'a'])]),
    );
  });

  test('self-dependency combined with dangling dependency', () => {
    const result = validateWorkItemGraph([node('a', ['a', 'ghost'])]);
    expect(result.errors.some((e) => e.type === 'self_dependency')).toBe(true);
    expect(result.errors.some((e) => e.type === 'dangling_dependency')).toBe(true);
  });

  test('realistic workflow IDs with prefixed format', () => {
    // Simulates the resolved ID format used at runtime: workflowId_taskId
    expectValid(
      validateWorkItemGraph([
        node('wf-123_setup'),
        node('wf-123_build', ['wf-123_setup']),
        node('wf-123_test', ['wf-123_build']),
      ]),
    );
  });

  test('realistic workflow with dangling dep on prefixed ID', () => {
    const result = validateWorkItemGraph([
      node('wf-123_setup'),
      node('wf-123_build', ['wf-123_setup', 'wf-123_missing']),
    ]);
    expectErrorOfType(result, 'dangling_dependency');
    expect(result.errors[0].message).toContain('wf-123_missing');
  });
});

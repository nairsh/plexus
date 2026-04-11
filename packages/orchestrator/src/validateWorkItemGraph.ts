/**
 * Pure graph-structure validation for work item dependency graphs.
 *
 * Detects: duplicate IDs, self-dependencies, dangling dependency references,
 * and dependency cycles.  Designed to run before execution dispatch so
 * malformed plans fail fast with actionable diagnostics.
 *
 * All functions are pure (no I/O, no DB) and operate on a minimal node shape
 * so they can be called from any layer without coupling to persistence.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal node shape required for validation — decoupled from WorkItem. */
export interface GraphNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export type GraphErrorType =
  | 'duplicate_id'
  | 'self_dependency'
  | 'dangling_dependency'
  | 'dependency_cycle';

export interface GraphValidationError {
  readonly type: GraphErrorType;
  readonly message: string;
  /** IDs of the tasks involved in this error. */
  readonly taskIds: readonly string[];
}

export interface GraphValidationResult {
  readonly valid: boolean;
  readonly errors: readonly GraphValidationError[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the structural integrity of a work item dependency graph.
 *
 * Checks are applied in order of severity:
 *   1. Duplicate task IDs  (ambiguous graph — skip remaining checks)
 *   2. Self-dependencies
 *   3. Dangling dependency references
 *   4. Dependency cycles  (only when there are no dangling references,
 *      since an incomplete graph makes cycle detection unreliable)
 *
 * Cycle detection uses Kahn's algorithm (BFS topological sort) — O(V + E).
 */
export function validateWorkItemGraph(
  nodes: readonly GraphNode[],
): GraphValidationResult {
  const errors: GraphValidationError[] = [];

  if (nodes.length === 0) {
    return { valid: true, errors: [] };
  }

  // --- Pass 1: duplicate IDs ------------------------------------------------
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const node of nodes) {
    if (seen.has(node.id)) {
      duplicates.add(node.id);
    }
    seen.add(node.id);
  }

  for (const id of duplicates) {
    errors.push({
      type: 'duplicate_id',
      message: `Duplicate task ID: '${id}'`,
      taskIds: [id],
    });
  }

  if (duplicates.size > 0) {
    // Graph is ambiguous — further checks would be misleading.
    return { valid: false, errors };
  }

  // --- Pass 2: self-dependencies & dangling references ----------------------
  const idSet = seen; // reuse — all IDs are unique at this point
  let hasDangling = false;

  for (const node of nodes) {
    for (const depId of node.dependsOn) {
      if (depId === node.id) {
        errors.push({
          type: 'self_dependency',
          message: `Task '${node.id}' depends on itself`,
          taskIds: [node.id],
        });
      } else if (!idSet.has(depId)) {
        hasDangling = true;
        errors.push({
          type: 'dangling_dependency',
          message: `Task '${node.id}' depends on non-existent task '${depId}'`,
          taskIds: [node.id, depId],
        });
      }
    }
  }

  // --- Pass 3: cycle detection (Kahn's algorithm) ---------------------------
  // Only meaningful when the graph is complete (no dangling references).
  // Self-dependencies are excluded from edge enumeration since they are
  // already reported above and would inflate in-degrees without adding
  // useful cycle information.
  if (!hasDangling) {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      dependents.set(node.id, []);
    }

    for (const node of nodes) {
      for (const depId of node.dependsOn) {
        if (depId === node.id) continue; // skip self-deps
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        dependents.get(depId)!.push(node.id);
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    let processed = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      processed++;
      for (const dep of dependents.get(current)!) {
        const newDegree = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) queue.push(dep);
      }
    }

    if (processed < nodes.length) {
      const cycleNodeIds = [...inDegree.entries()]
        .filter(([, degree]) => degree > 0)
        .map(([id]) => id);

      errors.push({
        type: 'dependency_cycle',
        message: `Dependency cycle detected among tasks: ${cycleNodeIds.join(', ')}`,
        taskIds: cycleNodeIds,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format validation errors into a single human-readable message.
 * Suitable for error constructors and log entries.
 */
export function formatGraphErrors(
  errors: readonly GraphValidationError[],
): string {
  if (errors.length === 0) return '';
  if (errors.length === 1) return errors[0].message;
  return errors.map((e, i) => `${i + 1}. ${e.message}`).join('; ');
}

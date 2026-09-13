/**
 * Regression tests for durable workflow state snapshot persistence.
 *
 * These tests prove that conversational state survives server restarts (simulated
 * by clearing the in-memory `workflows` Map and re-hydrating from SQLite).
 *
 * Verified scenarios:
 *   1. Pause (clarification) → clear in-memory → hydrate → full context preserved
 *   2. Continue workflow   → clear in-memory → hydrate → follow-up conversation preserved
 *   3. Config/objective consistency after continuation (both `workflows.config` JSON
 *      column and the snapshot `config` stay in sync)
 *   4. Explicit user-triggered pause → clear → hydrate → conversation preserved
 *   5. Snapshot versioning: multiple snapshots per workflow, latest wins
 *   6. Legacy fallback: workflows created before snapshots still hydrate
 *
 * Explicitly tested degraded behavior:
 *   7. Pending approval *metadata* is persisted, but the live Promise resolver is
 *      NOT restored — the hydrated `approvalState.pending` Map is empty.  Callers
 *      must re-request approval from the user.
 *   8. Subagent run *summaries* (status, output) are persisted in the snapshot,
 *      but the live Promise handle is NOT restored — `subagentRuns` is empty after
 *      hydration.  The orchestrator loop will re-query task status from the DB.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { closeDb, getDb, runMigrations, resetEnvCache } from '@orchestrator/shared';
import type { WorkflowConfig } from '@orchestrator/shared';

// We import directly from source modules (not the barrel) so tests don't pull
// in the full engine with its side-effects (sandbox, model-router, billing).
import {
  persistWorkflowSnapshot,
  loadLatestSnapshot,
  hydrateWorkflowState,
  persistWorkflowStatus,
  insertWorkflow,
  updateWorkflowObjectiveForContinuation,
  type ApprovalMetadata,
} from '../packages/orchestrator/src/workflow/persistence.js';
import { createWorkflowState, type WorkflowState, workflows } from '../packages/orchestrator/src/workflow/state.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_USER = 'test-user';

/** Insert a test user (idempotent) and a workflow row with the given config. */
function seedWorkflow(workflowId: string, config: WorkflowConfig, status: string = 'executing'): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO users (id, email, tier, credits_balance) VALUES (?, ?, ?, ?)`).run(
    TEST_USER,
    'test@example.test',
    'pro',
    100
  );
  db.prepare(
    `INSERT INTO workflows (id, user_id, objective, status, config, orchestrator_model, started_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(workflowId, TEST_USER, config.objective, status, JSON.stringify(config), 'test-model');
}

/** Create an in-memory WorkflowState and register it in the global map. */
function buildState(
  workflowId: string,
  config: WorkflowConfig,
  overrides?: Partial<Parameters<typeof createWorkflowState>[0]>
): WorkflowState {
  const state = createWorkflowState({
    id: workflowId,
    userId: TEST_USER,
    config,
    orchestratorModel: 'test-model',
    status: 'executing',
    ...overrides,
  });
  workflows.set(workflowId, state);
  return state;
}

/**
 * Simulate a server restart: wipe all in-memory workflow state.
 * After this, only SQLite persisted data remains.
 */
function simulateServerRestart(): void {
  workflows.clear();
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('workflow state snapshot recovery', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wf-snapshot-test-'));
    process.env['DATABASE_PATH'] = join(tempDir, 'test.db');
    closeDb();
    resetEnvCache();
    runMigrations();
    workflows.clear();
  });

  afterEach(() => {
    workflows.clear();
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Pause / clarification → clear → hydrate
  // ═══════════════════════════════════════════════════════════════════════════

  test('paused/clarification workflow survives clearing the in-memory map', () => {
    const wfId = 'wf-pause-clarification';
    const config: WorkflowConfig = { objective: 'Build a REST API' };
    seedWorkflow(wfId, config, 'paused');

    // Build multi-turn conversation that led to a clarification pause:
    //   user → assistant (plan) → user (tool results) → assistant (clarification question)
    const state = buildState(wfId, config, { status: 'paused' });
    state.messages.push({ role: 'assistant', content: 'I will start by setting up the project structure.' });
    state.messages.push({ role: 'user', content: 'Tool results:\n- write_todo: {"status":"ok"}' });
    state.messages.push({ role: 'assistant', content: 'Which database do you prefer: PostgreSQL or SQLite?' });
    state.conversationHistory.push(
      {
        role: 'assistant',
        content: 'I will start by setting up the project structure.',
        timestamp: '2025-01-01T00:00:01Z',
      },
      {
        role: 'assistant',
        content: 'Which database do you prefer: PostgreSQL or SQLite?',
        timestamp: '2025-01-01T00:00:02Z',
      }
    );
    state.creditsConsumed = 0.42;

    // Snapshot at the pause boundary (matches what loop.ts does)
    persistWorkflowSnapshot(state);

    // ── Server restart ──
    simulateServerRestart();

    // Hydrate and verify full conversation survived
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();

    // All 4 messages preserved (initial user + 3 added)
    expect(hydrated!.messages).toHaveLength(4);
    expect(hydrated!.messages[0]).toEqual({ role: 'user', content: 'Build a REST API' });
    expect(hydrated!.messages[1]).toEqual({
      role: 'assistant',
      content: 'I will start by setting up the project structure.',
    });
    expect(hydrated!.messages[2]).toEqual({ role: 'user', content: 'Tool results:\n- write_todo: {"status":"ok"}' });
    expect(hydrated!.messages[3]).toEqual({
      role: 'assistant',
      content: 'Which database do you prefer: PostgreSQL or SQLite?',
    });

    // Conversation history preserved with timestamps
    expect(hydrated!.conversationHistory).toHaveLength(3); // 1 initial + 2 added
    expect(hydrated!.conversationHistory[1].content).toBe('I will start by setting up the project structure.');
    expect(hydrated!.conversationHistory[2].content).toBe('Which database do you prefer: PostgreSQL or SQLite?');
    expect(hydrated!.conversationHistory[2].timestamp).toBe('2025-01-01T00:00:02Z');

    // Status and config preserved
    expect(hydrated!.status).toBe('paused');
    expect(hydrated!.config.objective).toBe('Build a REST API');
    expect(hydrated!.creditsConsumed).toBe(0.42);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Continue workflow → clear → hydrate
  // ═══════════════════════════════════════════════════════════════════════════

  test('continuation survives clearing the in-memory map', () => {
    const wfId = 'wf-continue';
    const originalConfig: WorkflowConfig = {
      objective: 'Build a REST API',
      max_credits: 10,
    };
    seedWorkflow(wfId, originalConfig, 'paused');

    // Phase 1: Build a paused state with conversation
    const state = buildState(wfId, originalConfig, { status: 'paused' });
    state.messages.push({ role: 'assistant', content: 'Which framework do you want to use?' });
    state.conversationHistory.push({
      role: 'assistant',
      content: 'Which framework do you want to use?',
      timestamp: '2025-01-01T00:00:01Z',
    });
    persistWorkflowSnapshot(state);

    // Phase 2: User continues with follow-up (mirrors engine.ts continueWorkflow)
    const followUp = 'Use Express with PostgreSQL';
    state.config = { ...state.config, objective: followUp };
    state.status = 'executing';
    state.messages.push({ role: 'user', content: followUp });
    state.conversationHistory.push({
      role: 'user',
      content: followUp,
      timestamp: '2025-01-01T00:01:00Z',
    });
    updateWorkflowObjectiveForContinuation(wfId, followUp);
    persistWorkflowSnapshot(state);

    // ── Server restart ──
    simulateServerRestart();

    // Hydrate and verify the FULL multi-turn conversation survived
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();

    // 3 messages: original user → assistant clarification → user follow-up
    expect(hydrated!.messages).toHaveLength(3);
    expect(hydrated!.messages[0]).toEqual({ role: 'user', content: 'Build a REST API' });
    expect(hydrated!.messages[1]).toEqual({ role: 'assistant', content: 'Which framework do you want to use?' });
    expect(hydrated!.messages[2]).toEqual({ role: 'user', content: 'Use Express with PostgreSQL' });

    // Config reflects the continuation
    expect(hydrated!.config.objective).toBe('Use Express with PostgreSQL');
    // Non-objective config fields preserved
    expect(hydrated!.config.max_credits).toBe(10);

    // Conversation history matches
    expect(hydrated!.conversationHistory).toHaveLength(3);
    expect(hydrated!.conversationHistory[2].content).toBe('Use Express with PostgreSQL');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Config/objective consistency after continuation
  // ═══════════════════════════════════════════════════════════════════════════

  test('config and objective stay consistent after continuation across all persisted sources', () => {
    const wfId = 'wf-config-consistency';
    const originalConfig: WorkflowConfig = {
      objective: 'Build a dashboard',
      working_directory: '/home/user/project',
      max_credits: 5,
      human_approval: true,
    };
    seedWorkflow(wfId, originalConfig, 'paused');

    const state = buildState(wfId, originalConfig, { status: 'paused' });
    persistWorkflowSnapshot(state);

    // Continue with new objective
    const followUp = 'Add user authentication to the dashboard';
    state.config = { ...state.config, objective: followUp };
    state.messages.push({ role: 'user', content: followUp });
    updateWorkflowObjectiveForContinuation(wfId, followUp);
    persistWorkflowSnapshot(state);

    // Verify ALL three persistence sources agree:

    // Source 1: workflows table `objective` column
    const db = getDb();
    const wfRow = db.prepare('SELECT objective, config FROM workflows WHERE id = ?').get(wfId) as {
      objective: string;
      config: string;
    };
    expect(wfRow.objective).toBe(followUp);

    // Source 2: workflows table `config` JSON column
    const parsedDbConfig = JSON.parse(wfRow.config) as WorkflowConfig;
    expect(parsedDbConfig.objective).toBe(followUp);
    expect(parsedDbConfig.max_credits).toBe(5);
    expect(parsedDbConfig.human_approval).toBe(true);
    expect(parsedDbConfig.working_directory).toBe('/home/user/project');

    // Source 3: latest snapshot `config`
    const snapshot = loadLatestSnapshot(wfId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.config.objective).toBe(followUp);
    expect(snapshot!.config.max_credits).toBe(5);

    // Source 4: hydrated state after restart
    simulateServerRestart();
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated!.config.objective).toBe(followUp);
    expect(hydrated!.config.max_credits).toBe(5);
    expect(hydrated!.config.human_approval).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Explicit user-triggered pause → clear → hydrate
  // ═══════════════════════════════════════════════════════════════════════════

  test('explicit user pause (not clarification) preserves conversation after restart', () => {
    const wfId = 'wf-explicit-pause';
    const config: WorkflowConfig = { objective: 'Run data migration' };
    seedWorkflow(wfId, config, 'paused');

    // Build conversation in progress
    const state = buildState(wfId, config, { status: 'executing' });
    state.messages.push({ role: 'assistant', content: 'Starting migration step 1 of 5...' });
    state.messages.push({ role: 'user', content: 'Tool results:\n- bash: {"exit_code":0}' });
    state.messages.push({ role: 'assistant', content: 'Step 1 complete. Starting step 2...' });
    state.creditsConsumed = 1.5;

    // User explicitly pauses (mirrors engine.ts pauseWorkflow)
    state.status = 'paused';
    persistWorkflowStatus(wfId, 'paused');
    persistWorkflowSnapshot(state);

    // ── Server restart ──
    simulateServerRestart();

    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.messages).toHaveLength(4); // initial + 3 added
    expect(hydrated!.messages[3].content).toBe('Step 1 complete. Starting step 2...');
    expect(hydrated!.status).toBe('paused');
    expect(hydrated!.creditsConsumed).toBe(1.5);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Snapshot versioning
  // ═══════════════════════════════════════════════════════════════════════════

  test('multiple snapshots are versioned and hydration uses the latest', () => {
    const wfId = 'wf-versioning';
    const config: WorkflowConfig = { objective: 'Test versioning' };
    seedWorkflow(wfId, config);

    const state = buildState(wfId, config);

    // Snapshot v1: just the initial objective
    persistWorkflowSnapshot(state);

    // Snapshot v2: one turn of progress
    state.messages.push({ role: 'assistant', content: 'Step 1 done' });
    state.conversationHistory.push({
      role: 'assistant',
      content: 'Step 1 done',
      timestamp: '2025-01-01T00:01:00Z',
    });
    persistWorkflowSnapshot(state);

    // Snapshot v3: more progress
    state.messages.push({ role: 'user', content: 'Tool results:\n- ok' });
    state.messages.push({ role: 'assistant', content: 'Step 2 done' });
    state.creditsConsumed = 2.0;
    persistWorkflowSnapshot(state);

    // All 3 versions persisted
    const db = getDb();
    const count = db
      .prepare('SELECT COUNT(*) AS cnt FROM workflow_state_snapshots WHERE workflow_id = ?')
      .get(wfId) as { cnt: number };
    expect(count.cnt).toBe(3);

    // Latest snapshot (v3) wins
    const latest = loadLatestSnapshot(wfId);
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(3);
    expect(latest!.messages).toHaveLength(4); // initial + 3 added
    expect(latest!.creditsConsumed).toBe(2.0);

    // Hydration after restart uses v3
    simulateServerRestart();
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated!.messages).toHaveLength(4);
    expect(hydrated!.creditsConsumed).toBe(2.0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Legacy fallback (no snapshot exists)
  // ═══════════════════════════════════════════════════════════════════════════

  test('hydration without snapshot falls back to objective-only reconstruction', () => {
    const wfId = 'wf-legacy';
    const config: WorkflowConfig = { objective: 'Legacy workflow' };
    seedWorkflow(wfId, config, 'paused');

    // No snapshot persisted — simulates a workflow created before snapshots existed

    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();
    // Falls back to minimal reconstruction: just the initial objective
    expect(hydrated!.messages).toHaveLength(1);
    expect(hydrated!.messages[0]).toEqual({ role: 'user', content: 'Legacy workflow' });
    expect(hydrated!.config.objective).toBe('Legacy workflow');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. DEGRADED BEHAVIOR: Pending approval resolvers are NOT restored
  //
  // The approval metadata (commandKey, toolName, requestedAt, etc.) is
  // persisted in the snapshot so the UI can re-display what was pending.
  // But the Promise `resolve` callback is inherently non-serialisable,
  // so after hydration `approvalState.pending` is empty.  The orchestrator
  // must re-request approval from the user on resume.
  // ═══════════════════════════════════════════════════════════════════════════

  test('pending approval metadata is persisted but live resolvers are NOT restored after hydration', () => {
    const wfId = 'wf-approval-degraded';
    const config: WorkflowConfig = { objective: 'Approval test', human_approval: true };
    seedWorkflow(wfId, config, 'paused');

    const state = buildState(wfId, config, { status: 'paused' });

    // Add a pending approval with a live resolve callback
    let resolverCalled = false;
    state.approvalState.pending.set('approval-1', {
      resolve: () => {
        resolverCalled = true;
      },
      commandKey: 'bash:rm -rf',
      command: 'rm -rf /tmp/test',
      toolName: 'bash',
      subagentId: 'sub-1',
      requestedAt: '2025-01-01T00:00:00Z',
    });

    persistWorkflowSnapshot(state);

    // Verify the snapshot contains the approval metadata
    const snapshot = loadLatestSnapshot(wfId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.pendingApprovalMetadata).toHaveLength(1);
    const meta: ApprovalMetadata = snapshot!.pendingApprovalMetadata[0]!;
    expect(meta.approvalId).toBe('approval-1');
    expect(meta.commandKey).toBe('bash:rm -rf');
    expect(meta.command).toBe('rm -rf /tmp/test');
    expect(meta.toolName).toBe('bash');
    expect(meta.subagentId).toBe('sub-1');
    expect(meta.requestedAt).toBe('2025-01-01T00:00:00Z');

    // ── Server restart ──
    simulateServerRestart();

    // Hydrate — the live `resolve` callback is intentionally NOT restored.
    // approvalState.pending should be empty (fresh Map from createWorkflowState).
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.approvalState.pending.size).toBe(0);
    // The approval must be re-requested by the orchestrator on resume.

    // Original resolver was never called (not leaked / not restored)
    expect(resolverCalled).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. DEGRADED BEHAVIOR: Subagent run Promises are NOT restored
  //
  // Subagent run summaries (runId, workItemId, status, output, error) are
  // persisted so the orchestrator knows what happened before the restart.
  // But the live `promise: Promise<void>` handle is non-serialisable, so
  // after hydration `subagentRuns` is empty.  The orchestrator loop will
  // re-discover task state from the `tasks` table.
  // ═══════════════════════════════════════════════════════════════════════════

  test('subagent summaries are persisted but live Promises are NOT restored after hydration', () => {
    const wfId = 'wf-subagent-degraded';
    const config: WorkflowConfig = { objective: 'Subagent test' };
    seedWorkflow(wfId, config);

    const state = buildState(wfId, config);

    // Add a completed subagent run with a live Promise
    const livePromise = Promise.resolve();
    state.subagentRuns.set('run-1', {
      runId: 'run-1',
      workItemId: 'task-1',
      status: 'completed',
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: '2025-01-01T00:01:00Z',
      output: 'Task completed successfully',
      promise: livePromise,
    });

    persistWorkflowSnapshot(state);

    // Verify the snapshot captured the summary fields
    const snapshot = loadLatestSnapshot(wfId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.subagentSummaries).toHaveLength(1);
    expect(snapshot!.subagentSummaries[0]!.runId).toBe('run-1');
    expect(snapshot!.subagentSummaries[0]!.status).toBe('completed');
    expect(snapshot!.subagentSummaries[0]!.output).toBe('Task completed successfully');

    // ── Server restart ──
    simulateServerRestart();

    // Hydrate — subagentRuns is intentionally empty (fresh Map from createWorkflowState).
    // The orchestrator loop re-reads task status from the `tasks` DB table.
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.subagentRuns.size).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Credits consumed survives round-trip
  // ═══════════════════════════════════════════════════════════════════════════

  test('credits consumed from snapshot takes precedence over workflow table on hydration', () => {
    const wfId = 'wf-credits';
    const config: WorkflowConfig = { objective: 'Credits test' };
    seedWorkflow(wfId, config);

    const state = buildState(wfId, config, { creditsConsumed: 3.456 });
    persistWorkflowSnapshot(state);

    simulateServerRestart();
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.creditsConsumed).toBe(3.456);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. CASCADE delete
  // ═══════════════════════════════════════════════════════════════════════════

  test('deleting workflow cascades to snapshot table', () => {
    const wfId = 'wf-cascade';
    const config: WorkflowConfig = { objective: 'Cascade test' };
    seedWorkflow(wfId, config);

    const state = buildState(wfId, config);
    persistWorkflowSnapshot(state);
    persistWorkflowSnapshot(state);

    const db = getDb();
    expect(
      (
        db.prepare('SELECT COUNT(*) AS cnt FROM workflow_state_snapshots WHERE workflow_id = ?').get(wfId) as {
          cnt: number;
        }
      ).cnt
    ).toBe(2);

    db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);

    expect(
      (
        db.prepare('SELECT COUNT(*) AS cnt FROM workflow_state_snapshots WHERE workflow_id = ?').get(wfId) as {
          cnt: number;
        }
      ).cnt
    ).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. Full lifecycle: create → pause → continue → restart → resume
  // ═══════════════════════════════════════════════════════════════════════════

  test('full lifecycle: create → multi-turn → pause → continue → restart → hydrate preserves everything', () => {
    const wfId = 'wf-lifecycle';
    const config: WorkflowConfig = {
      objective: 'Implement user auth',
      max_credits: 20,
      human_approval: false,
    };
    seedWorkflow(wfId, config);

    // ── Phase 1: Create and run a few turns ──
    const state = buildState(wfId, config);
    persistWorkflowSnapshot(state); // initial creation snapshot

    state.messages.push({ role: 'assistant', content: 'I will implement JWT-based authentication.' });
    state.messages.push({ role: 'user', content: 'Tool results:\n- write_todo: {"status":"ok"}' });
    state.messages.push({ role: 'assistant', content: 'Do you want session-based or token-based auth?' });
    state.conversationHistory.push(
      { role: 'assistant', content: 'I will implement JWT-based authentication.', timestamp: '2025-01-01T00:00:01Z' },
      {
        role: 'assistant',
        content: 'Do you want session-based or token-based auth?',
        timestamp: '2025-01-01T00:00:02Z',
      }
    );
    state.creditsConsumed = 1.0;

    // ── Phase 2: Pause on clarification ──
    state.status = 'paused';
    persistWorkflowStatus(wfId, 'paused', 'Do you want session-based or token-based auth?');
    persistWorkflowSnapshot(state);

    // ── Phase 3: User continues ──
    const followUp = 'Use token-based JWT auth';
    state.config = { ...state.config, objective: followUp };
    state.status = 'executing';
    state.messages.push({ role: 'user', content: followUp });
    state.conversationHistory.push({
      role: 'user',
      content: followUp,
      timestamp: '2025-01-01T00:01:00Z',
    });
    state.creditsConsumed = 1.2;
    updateWorkflowObjectiveForContinuation(wfId, followUp);
    persistWorkflowSnapshot(state);

    // ── Phase 4: More work happens ──
    state.messages.push({ role: 'assistant', content: 'Implementing JWT with refresh tokens...' });
    state.messages.push({ role: 'user', content: 'Tool results:\n- code: {"files_written":3}' });
    state.creditsConsumed = 3.5;
    persistWorkflowSnapshot(state); // 4th snapshot

    // ── Server restart ──
    simulateServerRestart();

    // ── Phase 5: Hydrate and verify full state ──
    const hydrated = hydrateWorkflowState(wfId);
    expect(hydrated).not.toBeNull();

    // All 7 messages preserved across the full lifecycle
    expect(hydrated!.messages).toHaveLength(7);
    expect(hydrated!.messages[0].content).toBe('Implement user auth'); // original
    expect(hydrated!.messages[3].content).toBe('Do you want session-based or token-based auth?'); // clarification
    expect(hydrated!.messages[4].content).toBe('Use token-based JWT auth'); // follow-up
    expect(hydrated!.messages[6].content).toBe('Tool results:\n- code: {"files_written":3}'); // latest

    // Config reflects continuation
    expect(hydrated!.config.objective).toBe('Use token-based JWT auth');
    expect(hydrated!.config.max_credits).toBe(20);

    // Credits reflect latest state
    expect(hydrated!.creditsConsumed).toBe(3.5);

    // 4 snapshots in the audit trail
    const db = getDb();
    const versions = db
      .prepare('SELECT version FROM workflow_state_snapshots WHERE workflow_id = ? ORDER BY version')
      .all(wfId) as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });
});

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { logger } from './logger.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env['DATABASE_PATH'] || './data/orchestrator.db';
  const resolvedPath = resolve(dbPath);

  const applyPragmas = (database: Database.Database): void => {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 10000');
  };

  try {
    db = new Database(resolvedPath);
    applyPragmas(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCorrupt =
      message.includes('malformed database schema') ||
      message.includes('database disk image is malformed');

    if (!isCorrupt || process.env['NODE_ENV'] === 'production') {
      throw error;
    }

    try {
      if (db) {
        db.close();
      }
    } catch {
      // Ignore close failures while recovering corrupted DB.
    }
    db = null;

    if (existsSync(resolvedPath)) {
      const stamp = Date.now();
      const backupPath = `${resolvedPath}.corrupt-${stamp}`;
      try {
        renameSync(resolvedPath, backupPath);
      } catch {
        // Another process may have already moved the file.
      }

      const walPath = `${resolvedPath}-wal`;
      if (existsSync(walPath)) {
        try {
          renameSync(walPath, `${walPath}.corrupt-${stamp}`);
        } catch {
          // Another process may have already moved the WAL file.
        }
      }

      const shmPath = `${resolvedPath}-shm`;
      if (existsSync(shmPath)) {
        try {
          renameSync(shmPath, `${shmPath}.corrupt-${stamp}`);
        } catch {
          // Another process may have already moved the SHM file.
        }
      }

      logger.warn({ path: resolvedPath, backupPath, error: message }, 'Corrupted SQLite database moved aside');
    }

    db = new Database(resolvedPath);
    applyPragmas(db);
  }

  logger.info({ path: resolvedPath }, 'SQLite database connected');

  return db;
}

export function runMigrations(): void {
  const database = getDb();

  const addColumnIfMissing = (table: string, column: string, definition: string) => {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  database.exec(`
    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'max', 'enterprise')),
      credits_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Credit ledger (append-only for auditability)
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, created_at);

    -- Model registry
    CREATE TABLE IF NOT EXISTS model_registry (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      cost_per_1m_input REAL NOT NULL,
      cost_per_1m_output REAL NOT NULL,
      max_output_tokens INTEGER,
      context_window INTEGER,
      supports_streaming INTEGER DEFAULT 1,
      supports_tools INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'disabled')),
      fallback_models TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Workflows
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      objective TEXT NOT NULL,
      user_prompt TEXT NOT NULL DEFAULT '',
      orchestrator_model TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','planning','executing','paused','completed','failed','cancelled')),
      plan TEXT,
      config TEXT,
      started_at TEXT,
      ended_at TEXT,
      credits_consumed REAL NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_user_created ON workflows(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      parent_task_ids TEXT NOT NULL DEFAULT '[]',
      task_type TEXT NOT NULL CHECK (task_type IN ('llm_completion','web_search','code_execution','browser_action','file_operation','api_call','human_approval','research','analyze','write','code','file')),
      description TEXT,
      model TEXT,
      tools TEXT,
      input_context TEXT,
      output TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','blocked','cancelled','skipped')),
      sandbox_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      cost TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id, status);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      step_type TEXT NOT NULL CHECK (step_type IN ('orchestrator_message','tool_call','tool_result','subagent_spawn','subagent_message','subagent_tool_call','subagent_tool_result','system_event','orchestrator_thinking')),
      model_name TEXT,
      message_content TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      subagent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_time ON workflow_steps(workflow_id, timestamp, created_at);

    CREATE TABLE IF NOT EXISTS sandbox_workspaces (
      user_id TEXT NOT NULL REFERENCES users(id),
      chat_id TEXT NOT NULL,
      active_session_id TEXT REFERENCES sandbox_sessions(id),
      language TEXT NOT NULL CHECK (language IN ('python', 'javascript', 'sql')),
      workspace_path TEXT NOT NULL,
      metadata_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','activating','active','error')),
      last_activated_at TEXT,
      last_deactivated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_workspaces_chat ON sandbox_workspaces(chat_id);

    -- Sandbox sessions
    CREATE TABLE IF NOT EXISTS sandbox_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      chat_id TEXT,
      language TEXT NOT NULL CHECK (language IN ('python', 'javascript', 'sql')),
      working_dir TEXT,
      open_terminal_url TEXT,
      environment_status TEXT NOT NULL DEFAULT 'running' CHECK (environment_status IN ('stopped','starting','running')),
      status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','ready','executing','terminated','error')),
      config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      terminated_at TEXT
    );

    -- Audit log (append-only)
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workflow_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
  `);

  addColumnIfMissing('workflows', 'user_prompt', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('workflows', 'orchestrator_model', 'TEXT');
  addColumnIfMissing('workflows', 'started_at', 'TEXT');
  addColumnIfMissing('workflows', 'ended_at', 'TEXT');
  addColumnIfMissing('workflows', 'schedule_id', 'TEXT');
  addColumnIfMissing('workflows', 'pause_reason', 'TEXT');
  addColumnIfMissing('workflows', 'output', 'TEXT');
  addColumnIfMissing('tasks', 'model', 'TEXT');
  addColumnIfMissing('tasks', 'tools', 'TEXT');
  // Note: updated_at column will be added via table recreation below
  addColumnIfMissing('sandbox_sessions', 'chat_id', 'TEXT');
  addColumnIfMissing('sandbox_sessions', 'open_terminal_url', 'TEXT');
  addColumnIfMissing('sandbox_sessions', 'open_terminal_api_key', 'TEXT');
  addColumnIfMissing('sandbox_sessions', 'environment_status', "TEXT NOT NULL DEFAULT 'running'");

  const workspaceTableInfo = database.prepare('PRAGMA table_info(sandbox_workspaces)').all() as Array<{
    name: string;
    pk: number;
  }>;
  const hasLegacyWorkspacePk =
    workspaceTableInfo.length > 0 &&
    workspaceTableInfo.some((column) => column.name === 'chat_id' && column.pk === 1) &&
    !workspaceTableInfo.some((column) => column.name === 'user_id' && column.pk > 0);

  if (hasLegacyWorkspacePk) {
    logger.info('Migrating sandbox_workspaces to composite (user_id, chat_id) primary key...');

    database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec(`
        DROP TABLE IF EXISTS sandbox_workspaces_new;

        CREATE TABLE sandbox_workspaces_new (
          user_id TEXT NOT NULL REFERENCES users(id),
          chat_id TEXT NOT NULL,
          active_session_id TEXT,
          language TEXT NOT NULL CHECK (language IN ('python', 'javascript', 'sql')),
          workspace_path TEXT NOT NULL,
          metadata_path TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','activating','active','error')),
          last_activated_at TEXT,
          last_deactivated_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, chat_id)
        );

        INSERT OR REPLACE INTO sandbox_workspaces_new (
          user_id, chat_id, active_session_id, language, workspace_path, metadata_path,
          status, last_activated_at, last_deactivated_at, created_at, updated_at
        )
        SELECT
          user_id, chat_id, active_session_id, language, workspace_path, metadata_path,
          status, last_activated_at, last_deactivated_at, created_at, updated_at
        FROM sandbox_workspaces;

        DROP TABLE sandbox_workspaces;
        ALTER TABLE sandbox_workspaces_new RENAME TO sandbox_workspaces;

        CREATE INDEX IF NOT EXISTS idx_sandbox_workspaces_chat ON sandbox_workspaces(chat_id);
      `);
      logger.info('sandbox_workspaces migration completed');
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }

  const sandboxSessionsSqlRow = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sandbox_sessions'")
    .get() as { sql?: string } | undefined;
  const hasLegacySessionWorkspaceFk = Boolean(
    sandboxSessionsSqlRow?.sql?.includes('REFERENCES sandbox_workspaces(chat_id)')
  );

  if (hasLegacySessionWorkspaceFk) {
    logger.info('Migrating sandbox_sessions to remove chat_id foreign key constraint...');

    database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec(`
        DROP TABLE IF EXISTS sandbox_sessions_new;

        CREATE TABLE sandbox_sessions_new (
          id TEXT PRIMARY KEY,
          task_id TEXT REFERENCES tasks(id),
          user_id TEXT NOT NULL REFERENCES users(id),
          chat_id TEXT,
          language TEXT NOT NULL CHECK (language IN ('python', 'javascript', 'sql')),
          working_dir TEXT,
          open_terminal_url TEXT,
          open_terminal_api_key TEXT,
          environment_status TEXT NOT NULL DEFAULT 'running' CHECK (environment_status IN ('stopped','starting','running')),
          status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','ready','executing','terminated','error')),
          config TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          terminated_at TEXT
        );

        INSERT INTO sandbox_sessions_new (
          id, task_id, user_id, chat_id, language, working_dir,
          open_terminal_url, open_terminal_api_key, environment_status,
          status, config, created_at, terminated_at
        )
        SELECT
          id, task_id, user_id, chat_id, language, working_dir,
          open_terminal_url, open_terminal_api_key, environment_status,
          status, config, created_at, terminated_at
        FROM sandbox_sessions;

        DROP TABLE sandbox_sessions;
        ALTER TABLE sandbox_sessions_new RENAME TO sandbox_sessions;
      `);
      logger.info('sandbox_sessions migration completed');
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Update task_type CHECK constraint to include new agent types
  // Note: SQLite doesn't support ALTER TABLE for CHECK constraints
  // We recreate the tasks table with the updated constraint
  const hasResearchType = database.prepare("SELECT 1 FROM sqlite_master WHERE sql LIKE '%research%' AND name='tasks'").get();
  if (!hasResearchType) {
    logger.info('Updating tasks table to support new agent types...');
    
    // Temporarily disable foreign keys to allow table recreation
    database.exec('PRAGMA foreign_keys = OFF');
    
    try {
      database.exec(`
        -- Drop temporary table if exists from previous failed migration
        DROP TABLE IF EXISTS tasks_new;
        
        -- Create new tasks table with updated schema
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
          parent_task_ids TEXT NOT NULL DEFAULT '[]',
          task_type TEXT NOT NULL CHECK (task_type IN ('llm_completion','web_search','code_execution','browser_action','file_operation','api_call','human_approval','research','analyze','write','code','file')),
          description TEXT,
          model TEXT,
          tools TEXT,
          input_context TEXT,
          output TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','blocked','cancelled','skipped')),
          sandbox_id TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          cost TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        
        -- Copy data from old table (explicit columns to handle schema differences)
        INSERT INTO tasks_new (id, workflow_id, parent_task_ids, task_type, description, model, tools, input_context, output, status, sandbox_id, retry_count, cost, started_at, completed_at, created_at, updated_at)
        SELECT id, workflow_id, parent_task_ids, task_type, description, model, tools, input_context, output, status, sandbox_id, retry_count, cost, started_at, completed_at, created_at, COALESCE(updated_at, datetime('now')) FROM tasks;
        
        -- Drop old table and rename new one
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        
        -- Recreate index
        CREATE INDEX idx_tasks_workflow ON tasks(workflow_id, status);
      `);
      logger.info('Tasks table updated successfully');
    } finally {
      // Re-enable foreign keys
      database.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Update task_type CHECK constraint to include 'deep_research'
  const hasDeepResearchType = database.prepare("SELECT 1 FROM sqlite_master WHERE sql LIKE '%deep_research%' AND name='tasks'").get();
  if (!hasDeepResearchType) {
    logger.info('Updating tasks table to support deep_research agent type...');

    database.exec('PRAGMA foreign_keys = OFF');

    try {
      database.exec(`
        DROP TABLE IF EXISTS tasks_new;

        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
          parent_task_ids TEXT NOT NULL DEFAULT '[]',
          task_type TEXT NOT NULL CHECK (task_type IN ('llm_completion','web_search','code_execution','browser_action','file_operation','api_call','human_approval','research','analyze','write','code','file','deep_research')),
          description TEXT,
          model TEXT,
          tools TEXT,
          input_context TEXT,
          output TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','blocked','cancelled','skipped')),
          sandbox_id TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          cost TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO tasks_new (id, workflow_id, parent_task_ids, task_type, description, model, tools, input_context, output, status, sandbox_id, retry_count, cost, started_at, completed_at, created_at, updated_at)
        SELECT id, workflow_id, parent_task_ids, task_type, description, model, tools, input_context, output, status, sandbox_id, retry_count, cost, started_at, completed_at, created_at, updated_at FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;

        CREATE INDEX idx_tasks_workflow ON tasks(workflow_id, status);
      `);
      logger.info('Tasks table updated with deep_research type');
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }

  // ── Teams (beta) ─────────────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS team_shared_contexts (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'knowledge' CHECK (content_type IN ('instructions', 'knowledge', 'template', 'shared_instructions', 'message')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Git sandbox snapshots for coding agent rollback
    CREATE TABLE IF NOT EXISTS git_snapshots (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      workspace_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'committed', 'rolled_back')),
      files_changed TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Workflow templates
    CREATE TABLE IF NOT EXISTS workflow_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      config TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      is_public INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- User memories (persistent cross-session memory)
    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT 'general',
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      relevance_score REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id, category);
    CREATE INDEX IF NOT EXISTS idx_user_memories_key ON user_memories(user_id, key);

    -- User-defined skills (overrides/global extensions per user)
    CREATE TABLE IF NOT EXISTS user_skills (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt_addendum TEXT NOT NULL,
      tools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_skills_user ON user_skills(user_id, updated_at DESC);

    -- User model preferences (overrides global model config)
    CREATE TABLE IF NOT EXISTS user_model_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      default_orchestrator_model TEXT,
      orchestrator_models TEXT,
      agent_models TEXT,
      subagent_models TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Agent health tracking
    CREATE TABLE IF NOT EXISTS agent_health (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'degraded', 'unavailable')),
      last_success_at TEXT,
      last_failure_at TEXT,
      success_count_1h INTEGER NOT NULL DEFAULT 0,
      failure_count_1h INTEGER NOT NULL DEFAULT 0,
      total_latency_ms_1h INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_type, model)
    );

    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('github', 'linear', 'notion')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error', 'disconnected')),
      display_name TEXT NOT NULL,
      external_id TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      credentials_encrypted TEXT,
      last_validated_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_connectors_user_provider ON connectors(user_id, provider, updated_at DESC);

    CREATE TABLE IF NOT EXISTS connector_oauth_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('github', 'linear', 'notion')),
      redirect_uri TEXT NOT NULL,
      state_token TEXT NOT NULL UNIQUE,
      code_verifier TEXT,
      requested_scopes TEXT NOT NULL DEFAULT '[]',
      frontend_origin TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_connector_oauth_state_lookup ON connector_oauth_states(state_token, provider);

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'upload' CHECK (source_type IN ('upload')),
      status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
      extraction_mode TEXT NOT NULL CHECK (extraction_mode IN ('text', 'ocr', 'document')),
      byte_size INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_user ON knowledge_documents(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(document_id, chunk_index);
  `);

  // ── Scheduled workflows ──────────────────────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_workflows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cron_expression TEXT,
      schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK (schedule_type IN ('cron', 'interval')),
      interval_value INTEGER,
      interval_unit TEXT CHECK (interval_unit IN ('minutes', 'hours', 'days', 'weeks', 'months')),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy IN ('skip', 'queue')),
      start_at TEXT,
      end_at TEXT,
      workflow_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
      last_run_at TEXT,
      next_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      active_workflow_id TEXT,
      last_run_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_workflows_next_run ON scheduled_workflows(status, next_run_at);
  `);

  addColumnIfMissing('scheduled_workflows', 'schedule_type', "TEXT NOT NULL DEFAULT 'cron'");
  addColumnIfMissing('scheduled_workflows', 'interval_value', 'INTEGER');
  addColumnIfMissing('scheduled_workflows', 'interval_unit', 'TEXT');
  addColumnIfMissing('scheduled_workflows', 'timezone', "TEXT NOT NULL DEFAULT 'UTC'");
  addColumnIfMissing('scheduled_workflows', 'overlap_policy', "TEXT NOT NULL DEFAULT 'skip'");
  addColumnIfMissing('scheduled_workflows', 'start_at', 'TEXT');
  addColumnIfMissing('scheduled_workflows', 'end_at', 'TEXT');
  addColumnIfMissing('scheduled_workflows', 'active_workflow_id', 'TEXT');
  addColumnIfMissing('scheduled_workflows', 'last_run_status', 'TEXT');

  // ── User API Providers (BYOK – bring your own key) ──────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_api_providers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'deepseek', 'google', 'openrouter', 'litellm', 'custom')),
      display_name TEXT NOT NULL,
      api_url TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL DEFAULT '',
      embedding_model TEXT,
      is_default_embedding INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_api_providers_user ON user_api_providers(user_id, provider_type);
  `);

  // Performance indexes for frequently queried columns
  getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_workflows_user_status ON workflows(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_templates_public_user ON workflow_templates(is_public, created_by);
  `);

  // Add team_id to workflows (nullable FK to teams)
  try {
    getDb().exec(`ALTER TABLE workflows ADD COLUMN team_id TEXT REFERENCES teams(id)`);
    logger.info('Added team_id column to workflows');
  } catch {
    // Column already exists — expected on subsequent runs
  }

  // Migrate team_shared_contexts to support 'shared_instructions' and 'message' content types
  try {
    const hasOldConstraint = getDb()
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='team_shared_contexts'`)
      .get() as { sql: string } | undefined;

    if (hasOldConstraint?.sql && !hasOldConstraint.sql.includes('shared_instructions')) {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS team_shared_contexts_new (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          content_type TEXT NOT NULL DEFAULT 'knowledge' CHECK (content_type IN ('instructions', 'knowledge', 'template', 'shared_instructions', 'message')),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO team_shared_contexts_new SELECT * FROM team_shared_contexts;
        DROP TABLE team_shared_contexts;
        ALTER TABLE team_shared_contexts_new RENAME TO team_shared_contexts;
      `);
      logger.info('Migrated team_shared_contexts CHECK constraint');
    }
  } catch (e) {
    logger.warn(`team_shared_contexts migration skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  // File index for cross-workflow file listing grouped by day
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS file_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      extension TEXT,
      size_bytes INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, workflow_id, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_file_index_user_date ON file_index(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_file_index_workflow ON file_index(workflow_id);
  `);

  // ── Add base_branch to git_snapshots for safe rollback ──────────────────────
  // Without this column, rollback guesses main/master which can corrupt the
  // user's original branch.  Legacy rows without a value get NULL; rollback
  // falls back to detaching HEAD at baseCommit for those rows.
  addColumnIfMissing('git_snapshots', 'base_branch', 'TEXT');

  // ── Embedding columns for semantic memory recall ──────────────────────────
  addColumnIfMissing('user_memories', 'embedding', 'TEXT');
  addColumnIfMissing('user_memories', 'embedding_model', 'TEXT');

  // ── Workflow state snapshots for durable pause/resume & crash recovery ────
  // Keyed by (workflow_id, version) so each state transition is auditable.
  // The latest version is used for hydration; older versions are retained for
  // debugging but never read during normal operation.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS workflow_state_snapshots (
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      messages TEXT NOT NULL,
      conversation_history TEXT NOT NULL,
      config TEXT NOT NULL,
      pending_approval_metadata TEXT,
      subagent_summaries TEXT,
      credits_consumed REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workflow_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_wf_snapshots_latest
      ON workflow_state_snapshots(workflow_id, version DESC);
  `);

  logger.info('Database migrations completed');
}

// ── File Index ───────────────────────────────────────────────────────────────

export interface FileIndexEntry {
  id: number;
  user_id: string;
  workflow_id: string;
  file_path: string;
  file_name: string;
  extension: string | null;
  size_bytes: number;
  created_at: string;
}

export interface FileIndexDayGroup {
  date: string;
  files: (FileIndexEntry & { workflow_objective?: string })[];
}

export function registerFileInIndex(
  userId: string,
  workflowId: string,
  filePath: string,
  sizeBytes: number = 0,
): void {
  const parts = filePath.split('/');
  const fileName = parts[parts.length - 1] || filePath;
  const dotIdx = fileName.lastIndexOf('.');
  const extension = dotIdx > 0 ? fileName.slice(dotIdx + 1).toLowerCase() : null;

  getDb().prepare(`
    INSERT OR REPLACE INTO file_index (user_id, workflow_id, file_path, file_name, extension, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(userId, workflowId, filePath, fileName, extension, sizeBytes);
}

export function listFilesByDay(userId: string, limit: number = 200): FileIndexDayGroup[] {
  const rows = getDb().prepare(`
    SELECT f.id, f.user_id, f.workflow_id, f.file_path, f.file_name, f.extension, f.size_bytes, f.created_at,
           w.objective as workflow_objective
    FROM file_index f
    LEFT JOIN workflows w ON f.workflow_id = w.id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ?
  `).all(userId, limit) as (FileIndexEntry & { workflow_objective?: string })[];

  const groups = new Map<string, (FileIndexEntry & { workflow_objective?: string })[]>();
  for (const row of rows) {
    const date = row.created_at.slice(0, 10); // YYYY-MM-DD
    const group = groups.get(date) ?? [];
    group.push(row);
    groups.set(date, group);
  }

  return Array.from(groups.entries()).map(([date, files]) => ({ date, files }));
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

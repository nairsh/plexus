import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { logger } from './logger.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env['DATABASE_PATH'] || './data/orchestrator.db';
  const resolvedPath = resolve(dbPath);

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');

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
    -- Users & auth
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'max', 'enterprise')),
      credits_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT,
      permissions TEXT NOT NULL DEFAULT '["all"]',
      last_used_at TEXT,
      revoked_at TEXT,
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
      step_type TEXT NOT NULL CHECK (step_type IN ('orchestrator_message','tool_call','tool_result','subagent_spawn','subagent_message','subagent_tool_call','subagent_tool_result','system_event')),
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
      chat_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      active_session_id TEXT REFERENCES sandbox_sessions(id),
      language TEXT NOT NULL CHECK (language IN ('python', 'javascript', 'sql')),
      workspace_path TEXT NOT NULL,
      metadata_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','activating','active','error')),
      last_activated_at TEXT,
      last_deactivated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sandbox sessions
    CREATE TABLE IF NOT EXISTS sandbox_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      chat_id TEXT REFERENCES sandbox_workspaces(chat_id),
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
  addColumnIfMissing('tasks', 'model', 'TEXT');
  addColumnIfMissing('tasks', 'tools', 'TEXT');
  // Note: updated_at column will be added via table recreation below
  addColumnIfMissing('sandbox_sessions', 'chat_id', 'TEXT REFERENCES sandbox_workspaces(chat_id)');
  addColumnIfMissing('sandbox_sessions', 'open_terminal_url', 'TEXT');
  addColumnIfMissing('sandbox_sessions', 'environment_status', "TEXT NOT NULL DEFAULT 'running'");

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
        
        -- Copy data from old table
        INSERT INTO tasks_new SELECT *, datetime('now') as updated_at FROM tasks;
        
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

  logger.info('Database migrations completed');
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

// Хранилище Depo. Встроенный node:sqlite, без внешних зависимостей.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  login       TEXT NOT NULL UNIQUE,
  pass_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  agent       TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  glyph       TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- id чата = session-id для claude; для codex ещё и thread_id
CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT 'Новый чат',
  provider        TEXT NOT NULL DEFAULT 'claude',
  model           TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  state           TEXT NOT NULL DEFAULT 'idle',   -- idle|running|attention|done|error
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  codex_thread    TEXT,
  claude_started  INTEGER NOT NULL DEFAULT 0,     -- была ли хоть одна сессия claude (для --resume)
  turns           INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  ctx_used        INTEGER NOT NULL DEFAULT 0,
  ctx_window      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS deleted_chats (
  id          TEXT PRIMARY KEY,
  deleted_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY,
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id    INTEGER,
  role      TEXT NOT NULL,      -- user|assistant|tool|system|error|handoff
  kind      TEXT,               -- text|thinking|tool_use|tool_result|notice
  text      TEXT,
  json      TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  model       TEXT,
  status      TEXT NOT NULL,    -- running|done|error|interrupted|cancelled
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  cost_usd    REAL DEFAULT 0,
  input_t     INTEGER DEFAULT 0,
  output_t    INTEGER DEFAULT 0,
  cache_r     INTEGER DEFAULT 0,
  cache_w     INTEGER DEFAULT 0,
  ctx_used    INTEGER DEFAULT 0,
  ctx_window  INTEGER DEFAULT 0,
  error       TEXT,
  pid         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_chat ON runs(chat_id, id DESC);

CREATE TABLE IF NOT EXISTS queued_messages (
  id          INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  attachments TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|sending|sent
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  run_id      INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_chat ON queued_messages(chat_id, status, id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS log (
  id    INTEGER PRIMARY KEY,
  ts    INTEGER NOT NULL,
  level TEXT NOT NULL,
  scope TEXT,
  text  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON log(ts DESC);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  keys        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- команда агентов: одна задача — план и шаги разных агентов по очереди
CREATE TABLE IF NOT EXISTS team_tasks (
  id          INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  task        TEXT NOT NULL,
  status      TEXT NOT NULL,          -- planning | await | running | done | stopped | error
  steps       TEXT NOT NULL DEFAULT '[]',
  step        INTEGER NOT NULL DEFAULT -1,
  retries     INTEGER NOT NULL DEFAULT 0,
  msg_id      INTEGER,
  attachments TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_team_chat ON team_tasks(chat_id, id);
`;

const MIGRATIONS = [
  "ALTER TABLE chats ADD COLUMN origin TEXT NOT NULL DEFAULT 'depo'",      // depo | claude | codex
  'ALTER TABLE chats ADD COLUMN import_offset INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE chats ADD COLUMN unread INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE chats ADD COLUMN effort TEXT NOT NULL DEFAULT ''",      // закончил работу, пока ты не смотрел
  "ALTER TABLE chats ADD COLUMN kimi_session TEXT",                   // id сессии Kimi Code CLI для resume
  "ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'Изучает проект'",
  'ALTER TABLE runs ADD COLUMN waiting_ms INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE runs ADD COLUMN wait_started_at INTEGER',
  'ALTER TABLE runs ADD COLUMN quota_start TEXT',
  'ALTER TABLE runs ADD COLUMN quota_end TEXT',
  'ALTER TABLE chats ADD COLUMN team INTEGER NOT NULL DEFAULT 0',      // чат работает командой агентов
];

export function open(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'depo.db'));
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) { try { db.exec(m); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
  return db;
}

export const now = () => Date.now();

// Удобные обёртки: .all/.get/.run с именованными или позиционными параметрами
export function helpers(db) {
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const setting = (k, v) => {
    if (v === undefined) return get('SELECT value FROM settings WHERE key=?', k)?.value;
    run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
    return v;
  };
  const log = (level, scope, text) => {
    run('INSERT INTO log(ts,level,scope,text) VALUES(?,?,?,?)', now(), level, scope, String(text).slice(0, 4000));
    if (level === 'error') console.error(new Date().toISOString(), scope, text);
  };
  return { all, get, run, setting, log };
}

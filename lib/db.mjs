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

CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT 'Новый чат',
  provider        TEXT NOT NULL DEFAULT 'claude',
  model           TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  state           TEXT NOT NULL DEFAULT 'idle',
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  codex_thread    TEXT,
  claude_started  INTEGER NOT NULL DEFAULT 0,
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
  role      TEXT NOT NULL,
  kind      TEXT,
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
  status      TEXT NOT NULL,
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
`;

const MIGRATIONS = [
  "ALTER TABLE chats ADD COLUMN origin TEXT NOT NULL DEFAULT 'depo'",
  'ALTER TABLE chats ADD COLUMN import_offset INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE chats ADD COLUMN unread INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE chats ADD COLUMN effort TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE chats ADD COLUMN kimi_session TEXT",
];

export function open(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'depo.db'));
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) { try { db.exec(m); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
  return db;
}

export const now = () => Date.now();

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

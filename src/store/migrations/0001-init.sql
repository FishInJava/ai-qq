-- M0：12 张表的初始形状。
-- 修正来源：spec D-14（life_events 去联合唯一、sessions 增加 unstarted、daily_budget 改行式计数）。
-- 增补：token_ledger；characters.card_source_path；sessions 三个标记位。
--
-- sessions.character_id 允许 NULL 且 ON DELETE SET NULL：
-- 删除 scope=card 时要保留会话与记录（spec D-12），因此不能级联删会话。
-- 卡片还在时仍由 UNIQUE 保证一卡一会话。

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  card_json TEXT NOT NULL,
  extensions_json TEXT,
  compat TEXT NOT NULL CHECK (compat IN ('v1', 'v2')),
  avatar_path TEXT,
  card_source_path TEXT,
  source_hash TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER UNIQUE REFERENCES characters(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'unstarted'
    CHECK (state IN ('unstarted', 'active', 'paused', 'dormant')),
  token_limit INTEGER NOT NULL DEFAULT 500000
    CHECK (token_limit BETWEEN 1 AND 10000000),
  token_used INTEGER NOT NULL DEFAULT 0 CHECK (token_used >= 0),
  pause_gap_hours REAL CHECK (pause_gap_hours IS NULL OR pause_gap_hours >= 0),
  last_user_msg_at TEXT,
  last_proactive_at TEXT,
  consecutive_ignored INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_ignored >= 0),
  cold_start_silenced INTEGER NOT NULL DEFAULT 0 CHECK (cold_start_silenced IN (0, 1)),
  quota70_flagged INTEGER NOT NULL DEFAULT 0 CHECK (quota70_flagged IN (0, 1)),
  hard_dedup_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'char', 'system_note')),
  content TEXT NOT NULL,
  is_proactive INTEGER NOT NULL DEFAULT 0 CHECK (is_proactive IN (0, 1)),
  anchor_type TEXT CHECK (anchor_type IS NULL OR anchor_type IN ('event', 'fact', 'none')),
  anchor_id INTEGER,
  bubble_index INTEGER CHECK (bubble_index IS NULL OR bubble_index >= 0),
  tokens INTEGER CHECK (tokens IS NULL OR tokens >= 0),
  estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  incomplete INTEGER NOT NULL DEFAULT 0 CHECK (incomplete IN (0, 1)),
  style_flags TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'char', 'world')),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dropped')),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  source_msg_id INTEGER REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_msg_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  to_msg_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS life_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_date TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  content TEXT NOT NULL,
  used_by_msg_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proactive_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_budget (
  date TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (date, session_id)
);

CREATE TABLE IF NOT EXISTS world_feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('weather', 'holiday', 'news')),
  content TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (date, kind)
);

CREATE TABLE IF NOT EXISTS scheduler_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('timer', 'hard', 'manual')),
  decision TEXT NOT NULL CHECK (decision IN ('skip', 'send')),
  decision_reason TEXT NOT NULL,
  willingness REAL,
  next_tick_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'proactive', 'refill')),
  amount INTEGER NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_facts_session_status
  ON facts(session_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_current
  ON facts(session_id, subject, key) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_proactive_log_session_created
  ON proactive_log(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_state_created
  ON scheduler_state(created_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_state_session_created
  ON scheduler_state(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_life_events_session_date
  ON life_events(session_id, event_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_life_events_ordinal
  ON life_events(session_id, event_date, ordinal);
CREATE INDEX IF NOT EXISTS idx_token_ledger_session_created
  ON token_ledger(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_daily_budget_date
  ON daily_budget(date);

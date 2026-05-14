-- TechBot v2: Long-term memory table
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS user_memories (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  project     text,                    -- NULL = cross-project memory
  memory_type text NOT NULL DEFAULT 'fact', -- 'preference'|'fact'|'context'|'correction'
  content     text NOT NULL,
  importance  int  DEFAULT 5,          -- 1–10
  source_msg  text,
  created_at  timestamptz DEFAULT now(),
  accessed_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_user_project
  ON user_memories (user_id, project, importance DESC, accessed_at DESC);

-- Cap memories per user/project to 50 rows (delete oldest low-importance when over limit)
-- This is enforced by api/memory.js at write time, not a DB constraint.

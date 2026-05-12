-- Phase 1 Migration: Document Structure Awareness
-- Chạy trong Supabase SQL Editor (Dashboard → SQL Editor → New query)

ALTER TABLE documents ADD COLUMN IF NOT EXISTS section_title   text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS section_index   integer;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_position    integer;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS surrounding_text text;

-- Index để filter/sort theo section nhanh hơn
CREATE INDEX IF NOT EXISTS idx_documents_section
  ON documents (project, file_name, section_index, doc_position);

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'documents'
ORDER BY ordinal_position;

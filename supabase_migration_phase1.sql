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

-- Phase 1: Cập nhật hàm match_documents để trả về các cột mới
-- DROP trước vì không thể thay đổi return type bằng CREATE OR REPLACE
DROP FUNCTION IF EXISTS match_documents(vector, integer, text);

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(768),
  match_count     int     DEFAULT 5,
  filter_project  text    DEFAULT NULL
)
RETURNS TABLE (
  id               bigint,
  file_name        text,
  chunk_text       text,
  chunk_type       text,
  image_url        text,
  page             int,
  project          text,
  role             text,
  section_title    text,
  section_index    int,
  doc_position     int,
  surrounding_text text,
  similarity       float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.file_name,
    d.chunk_text,
    d.chunk_type,
    d.image_url,
    d.page,
    d.project,
    d.role,
    d.section_title,
    d.section_index,
    d.doc_position,
    d.surrounding_text,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM documents d
  WHERE
    (filter_project IS NULL OR d.project = filter_project)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

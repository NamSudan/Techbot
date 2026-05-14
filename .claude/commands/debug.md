# TechBot Debug Flow

Standard steps for diagnosing TechBot issues:

## Chat not responding
1. Check Vercel runtime logs via MCP `get_runtime_logs`
2. Look for `RATE_LIMIT:` or `INVALID_KEY:` in logs → guide user to fix API key
3. Check `api/chat.js` handler — trace the code path for the failing request type

## RAG returning wrong results
1. Check `api/embed.js` → `searchDocuments()` — verify `match_count` and `filter_project`
2. Run test query in Supabase SQL Editor: `SELECT chunk_text, section_title FROM documents WHERE project = 'X' LIMIT 5`
3. Check `classifyIntent()` in `embed.js` — intent affects topK (20 vs 5)

## Memory not persisting
1. Check `user_memories` table exists: use `list_tables` MCP
2. Check `api/memory.js` POST handler — look for Supabase auth errors in logs
3. Verify `userId` is sent in request body (check `index.html` → `sendMessage()`)

## Tool calls failing
1. Check `api/tools.js` → `executeTool()` for the specific tool
2. `calculate`: ensure expression is safe (no `import`, `require`, `process`)
3. `search_technical_standard`: DuckDuckGo may be slow — check 3s timeout
4. `rag_search`: verify Gemini key is valid for embedding

## File upload failing
1. Check file size — files >20MB are blocked client-side
2. For DOCX/PDF >4MB: check Vercel logs for timeout (ingest has 60s limit)
3. Check `api/ingest.js` for per-format parsing errors

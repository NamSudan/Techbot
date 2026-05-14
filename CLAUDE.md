# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

TechBot is a Vietnamese-language RAG (Retrieval-Augmented Generation) chatbot for technical documents. Users upload DOCX/XLSX/PDF/image files, the backend chunks and embeds them into Supabase, and the chat endpoint retrieves relevant chunks to answer questions with citations.

**Stack:** Single-file HTML frontend · Vercel Serverless Functions (Node ESM) · Supabase (PostgreSQL + pgvector) · Groq API (llama-3.3-70b-versatile) · Gemini API (gemini-1.5-flash + text-embedding-004)

## Local development

```bash
# Copy and fill in API keys
cp .env.example .env.local

# Install Vercel CLI (one-time)
npm install -g vercel

# Run local dev server (simulates Vercel serverless)
vercel dev
# → http://localhost:3000
```

There is no build step. `index.html` is served directly; the `api/` functions run as serverless functions. **Do not** use `node server.js` or `npm start` — the project requires `vercel dev` to wire up serverless function routing.

## Running tests

```bash
# Test DOCX XML structure parsing (no API keys needed)
node test_phase1.mjs
```

`test_phase1.mjs` has a hardcoded `DOCX_PATH` at the top — update it to point to a local `.docx` file before running.

## Deploying

```bash
vercel --prod
```

Environment variables (`GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`) must be set in the Vercel dashboard. After adding/changing env vars, redeploy.

## Database migrations

Schema changes go in `supabase_migration_phase1.sql`. Run them in the Supabase SQL Editor (Dashboard → SQL Editor → New query). The `match_documents` function return type cannot be changed with `CREATE OR REPLACE` — it must be `DROP`ped first (the migration file already handles this).

## Architecture

### Request flow

```
index.html (browser)
    ↓ POST /api/ingest  (upload + chunk + embed → Supabase)
    ↓ POST /api/chat    (embed query → vector search → augment → LLM)
    ↓ GET  /api/projects
    ↓ DELETE /api/delete
    ↓ POST /api/reembed
```

### `api/embed.js` — shared module

All other API files import from here. Key exports:
- `createEmbedding(text, geminiKey)` — Gemini text-embedding-004, 768 dimensions, truncates to 2000 chars
- `classifyIntent(userMessage)` — returns `'overview'` or `'detail'` based on Vietnamese keyword patterns
- `searchDocuments(embedding, project, intent)` — calls `match_documents` RPC; topK=20 for overview, 5 for detail
- `fetchSectionChunks(chunks, project)` — for `detail` intent, fetches all chunks from the same section to avoid losing context mid-section
- `saveChunks(rows)` — bulk insert into `documents` table
- `chunkText(text, 600, 100)` — splits by double-newlines, 600-char chunks with 100-char overlap

### `api/chat.js` — RAG chat endpoint

1. Embeds last user message → `searchDocuments` → `fetchSectionChunks` (if detail)
2. Appends a context block to the last user message (citations + instructions for `[N]` and `[IMG:N]` markers)
3. Routes to Gemini if: uploaded file is image/PDF **and** geminiKey is set, or RAG returned image citations with URLs; otherwise Groq
4. Returns `{ reply, engine, citations, chunks_used, failedImages, intent }`

### `api/ingest.js` — document ingestion pipeline

Handles per-format parsing before chunking:
- **DOCX**: Full XML parsing via JSZip (`word/document.xml` + relationship map). Detects headings by Word style (`Heading1`, etc.) and by heuristic (bold + ALL-CAPS + short text). Groups content by section. Hard cap of 20 images per document. Image chunks embed `description + surrounding context` for richer retrieval.
- **XLSX**: `xlsx` library → CSV per sheet; images from `xl/media/` via JSZip + Gemini Vision
- **PDF**: Gemini Vision if key available, raw BT/ET text extraction fallback
- **Images**: Direct Gemini Vision
- **Plain text** (txt, csv, json, md, log): UTF-8 decode + `chunkText`

Each ingested document is deduplicated by deleting existing rows for the same `(file_name, project)` before re-inserting.

### `api/parse.js` — parse-only (no storage)

Same parsing logic as `ingest.js` but returns extracted text + image descriptions without writing to Supabase. Used by the frontend for the "view file content" feature. For DOCX, uses `mammoth` for text extraction (simpler than ingest's full XML parse).

### Supabase schema

Table: `documents`

| Column | Type | Notes |
|--------|------|-------|
| `file_name` | text | Original filename |
| `project` | text | Project grouping |
| `role` | text | Role context at ingest time |
| `chunk_type` | text | `'text'` or `'image'` |
| `chunk_text` | text | Text content or Gemini Vision description |
| `image_url` | text | Public URL in `techbot-images` Supabase Storage bucket |
| `section_title` | text | Heading text this chunk falls under |
| `section_index` | int | Section sequence number in document |
| `doc_position` | int | Paragraph index in document |
| `surrounding_text` | text | Context text adjacent to an image chunk |
| `embedding` | vector(768) | Gemini text-embedding-004 |

`match_documents(query_embedding, match_count, filter_project)` — pgvector cosine similarity RPC.

### Frontend (`index.html`)

One monolithic file (~3500 lines) with all HTML, CSS, and JS inline. Key global state:
- `window.currentProject` — active project name (used in API calls)
- `currentRole` — active role (engineer/manager/etc.), shapes system prompt
- `localStorage['techbot_groq_key']` / `localStorage['techbot_gemini_key']` — user-supplied API keys
- `localStorage['techbot_chat_sessions']` — saved chat history

API keys flow: `getUserKeys()` reads from localStorage, keys are sent as `userKeys: { groq, gemini }` in every API request body. Server-side priority is always `userKeys.* || process.env.*`.

Response rendering: bot replies use `[N]` citation markers and `[IMG:N]` inline image placeholders which the frontend (`injectCitationRefs`, `injectInlineImages`) converts to footnotes and `<img>` tags.

## v2 Upgrade — New modules (added after initial release)

### `api/tools.js` — Tool definitions + executors

Exports `TOOL_SCHEMAS` (OpenAI-compatible array for Groq) and `executeTool(toolName, args, context)`.

4 tools:
- `calculate` — safe math eval via `new Function()` server-side
- `convert_unit` — hardcoded conversion table (pressure, length, mass, temperature, power, force, volume)
- `search_technical_standard` — DuckDuckGo instant answer API, 3s timeout, graceful degrade
- `rag_search` — calls `createEmbedding` + `searchDocuments` from `embed.js` for targeted sub-queries

### `api/memory.js` — Long-term memory CRUD

Reads/writes `user_memories` table. Operations: `GET ?userId&project` (top 20, sorted by importance), `POST` (save 1 memory), `DELETE ?id&userId`.

### `api/chat.js` — Agentic loop (v2)

`callGroqWithTools()` replaces the old `callGroq()`:
1. Loads user memories → injects into system prompt
2. Runs up to **3 tool-call iterations** (Groq `finish_reason: 'tool_calls'` → execute → append `role:'tool'` → continue)
3. Detects `CLARIF::` prefix in reply → sets `is_clarification: true` (rendered differently in frontend)
4. Fire-and-forgets `extractAndSaveMemories()` after each turn (never blocks response)
5. Returns `{ reply, engine, citations, chunks_used, is_clarification, toolResults }`

Response shape change from v1: adds `is_clarification` and `toolResults` fields.

### Supabase — `user_memories` table (v2)

| Column | Type | Notes |
|--------|------|-------|
| `id` | bigserial | PK |
| `user_id` | text | From `localStorage['techbot_user_id']` (auto-generated UUID-like) |
| `project` | text | NULL = cross-project memory |
| `memory_type` | text | `'preference'` \| `'fact'` \| `'context'` \| `'correction'` |
| `content` | text | The memory text (max ~500 chars) |
| `importance` | int | 1–10 scale |
| `created_at` | timestamptz | |
| `accessed_at` | timestamptz | Updated on each read |

Migration file: `supabase_migration_v2.sql` — run in Supabase SQL Editor.

### Frontend v2 additions (`index.html`)

New localStorage keys:
- `localStorage['techbot_user_id']` — persistent user ID (format: `u_<timestamp36>_<random>`)
- `localStorage['techbot_roles']` — JSON array of role objects (replaces hardcoded `rolePrompts`/`roleNames`)

Role object shape: `{ id, name, icon, description, isDefault }`. Defaults (engineer/trainer/operator) cannot be deleted but can be edited. Custom roles are fully user-managed via sidebar UI.

Large file handling: images >2MB auto-compressed via canvas; text files >3MB chunked client-side (multiple POST requests); DOCX/XLSX/PDF >4MB show extended progress toast; files >20MB blocked.

Clarification UI: bot replies prefixed `CLARIF::` render as purple bubble (`.msg-clarif-bubble`) instead of normal bot message.

Thinking mode: adds `'agent'` mode with steps "Phân tích → Lập kế hoạch → Thực thi → Tổng hợp" when query is complex.

---

## Custom slash commands

Available via Claude Code CLI in this project:
- `/status` — checks all dependencies (files, Supabase tables, env vars)
- `/deploy` — deployment checklist before `vercel --prod`
- `/debug` — guided debug flow for common TechBot issues

---

## Key conventions

- All `api/*.js` files are ESM (`"type": "module"` in package.json) and export a default `handler(req, res)` for Vercel.
- API files use direct `fetch` to Supabase REST/RPC endpoints — **not** the `@supabase/supabase-js` client (despite it being in dependencies).
- Error messages thrown from API functions use `RATE_LIMIT:` or `INVALID_KEY:` prefixes — the frontend parses these to display appropriate UI messages.
- Gemini Vision retries with exponential backoff (1s, 2s, 4s) on 429/5xx.
- `reembed.js` is paginated (batch of 20) with 120ms delay between requests to stay under Gemini's free-tier rate limit. The frontend calls it in a loop until `done: true`.
- `vercel.json` sets `maxDuration: 60` for `ingest.js` and `reembed.js` only; all other functions use Vercel's default.
- The Vietnamese system prompt in `chat.js` instructs the model to add `💡 GỢI Ý: ...` suggestion lines after document-based answers — do not remove this as the frontend may render it specially.

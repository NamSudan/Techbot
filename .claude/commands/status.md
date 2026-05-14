# TechBot Status Check

Check the health of TechBot's dependencies and report clearly:

1. Verify all required API files exist: `api/embed.js`, `api/chat.js`, `api/ingest.js`, `api/tools.js`, `api/memory.js`
2. List all tables in Supabase — confirm `documents` and `user_memories` both exist
3. Count rows in `documents` and `user_memories` via Supabase SQL
4. Check `vercel.json` for correct `maxDuration` settings on `ingest.js` and `chat.js`
5. Check `.env.local` exists (do NOT print values) — list which of these keys are present: `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`

Report: ✓ OK or ✗ MISSING for each item.

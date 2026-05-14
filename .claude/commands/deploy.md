# TechBot Deployment Checklist

Before running `vercel --prod`, verify each item:

1. **Database migration**: Check that `user_memories` table exists in Supabase (use list_tables MCP tool). If missing, run `supabase_migration_v2.sql` in Supabase SQL Editor first.
2. **Env vars in Vercel dashboard**: `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY` — check via Vercel MCP or remind user to verify manually.
3. **vercel.json**: Confirm `maxDuration: 60` for `ingest.js` and `maxDuration: 30` for `chat.js`.
4. **No syntax errors**: Run `node --input-type=module < api/chat.js` to catch ESM parse errors.
5. **Git status**: Ensure all changes are committed.

Then deploy: `vercel --prod`

After deploy, test with a simple chat message to confirm the endpoint responds.

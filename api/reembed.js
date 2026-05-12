/**
 * TechBot — Re-embed tất cả documents với text-embedding-004
 * POST /api/reembed
 *
 * Dùng pagination để tránh timeout Vercel (xử lý từng batch 20 docs).
 * Frontend gọi lặp lại với { offset } tăng dần cho đến khi done = true.
 *
 * Body: { offset?, batchSize?, userKeys? }
 * Response: { ok, processed, failed, nextOffset, done, model }
 */

import { createEmbedding } from './embed.js';

const DEFAULT_BATCH = 20;
const DELAY_MS = 120; // tránh rate limit Gemini (~500 req/phút với free tier)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { offset = 0, batchSize = DEFAULT_BATCH, userKeys = {} } = req.body || {};

  const geminiKey  = userKeys.gemini || process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();

  if (!geminiKey)   return res.status(400).json({ error: 'Thiếu Gemini API key — vào Cài đặt để nhập key của bạn' });
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Thiếu Supabase config' });

  // Lấy một batch documents
  const fetchRes = await fetch(
    `${supabaseUrl}/rest/v1/documents?select=id,chunk_text&order=id.asc&limit=${batchSize}&offset=${offset}`,
    { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
  );

  if (!fetchRes.ok) {
    return res.status(500).json({ error: `Supabase fetch lỗi: ${fetchRes.status}` });
  }

  const docs = await fetchRes.json();
  if (!docs.length) {
    return res.status(200).json({ ok: true, processed: 0, failed: 0, nextOffset: offset, done: true, model: 'text-embedding-004' });
  }

  let processed = 0;
  let failed = 0;

  for (const doc of docs) {
    try {
      const embedding = await createEmbedding(doc.chunk_text, geminiKey);

      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/documents?id=eq.${doc.id}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ embedding })
        }
      );

      if (patchRes.ok) {
        processed++;
      } else {
        console.warn(`[Reembed] PATCH failed doc ${doc.id}: ${patchRes.status}`);
        failed++;
      }
    } catch (e) {
      console.warn(`[Reembed] doc ${doc.id} error:`, e.message);
      failed++;
      // Rate limit: dừng batch hiện tại, trả về để frontend retry sau
      if (e.message.includes('RATE_LIMIT')) {
        return res.status(200).json({
          ok: false,
          processed,
          failed,
          nextOffset: offset + processed,
          done: false,
          rateLimited: true,
          model: 'text-embedding-004'
        });
      }
    }

    // Delay nhỏ giữa các request để tránh rate limit
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  const nextOffset = offset + docs.length;
  // done = true khi batch trả về ít hơn batchSize (không còn docs nữa)
  const done = docs.length < batchSize;

  return res.status(200).json({ ok: true, processed, failed, nextOffset, done, model: 'text-embedding-004' });
}

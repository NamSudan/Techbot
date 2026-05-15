/**
 * TechBot — API Health Check
 * POST /api/status
 * Returns real-time status for each API key: ok | warn (quota) | err (invalid/missing)
 */

async function checkGeminiModel(modelId, apiKey) {
  if (!apiKey) return { state: 'off', label: 'Chưa cấu hình' };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}?key=${apiKey}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) return { state: 'ok', label: 'Online' };
    if (res.status === 429) return { state: 'warn', label: 'Quota đầy' };
    if (res.status === 401 || res.status === 403) return { state: 'err', label: 'Key không hợp lệ' };
    const data = await res.json().catch(() => ({}));
    const msg = (data.error?.message || `HTTP ${res.status}`).slice(0, 45);
    return { state: 'err', label: msg };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { state: 'warn', label: 'Timeout' };
    return { state: 'err', label: 'Lỗi kết nối' };
  }
}

async function checkGroq(apiKey) {
  if (!apiKey) return { state: 'off', label: 'Chưa cấu hình' };
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) return { state: 'ok', label: 'Online · Free' };
    if (res.status === 429) return { state: 'warn', label: 'Rate limit' };
    if (res.status === 401 || res.status === 403) return { state: 'err', label: 'Key không hợp lệ' };
    return { state: 'err', label: `HTTP ${res.status}` };
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { state: 'warn', label: 'Timeout' };
    return { state: 'err', label: 'Lỗi kết nối' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userKeys = {} } = req.body || {};
  const geminiKey = userKeys.gemini || process.env.GEMINI_API_KEY;
  const groqKey   = userKeys.groq   || process.env.GROQ_API_KEY;

  const [groq, gemini_embed, gemini_vision] = await Promise.all([
    checkGroq(groqKey),
    checkGeminiModel('text-embedding-004', geminiKey),
    checkGeminiModel('gemini-1.5-flash',   geminiKey)
  ]);

  return res.status(200).json({
    groq,
    gemini_embed,
    gemini_vision,
    key_source: {
      groq:   userKeys.groq   ? 'user' : (process.env.GROQ_API_KEY   ? 'server' : 'none'),
      gemini: userKeys.gemini ? 'user' : (process.env.GEMINI_API_KEY ? 'server' : 'none')
    }
  });
}

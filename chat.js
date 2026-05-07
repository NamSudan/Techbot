/**
 * TechBot — Vercel Serverless Function
 * POST /api/chat
 *
 * Dùng Groq (llama3-70b) cho text, tự động fallback Gemini Flash nếu có file ảnh.
 * Biến môi trường cần set trên Vercel:
 *   GROQ_API_KEY   — https://console.groq.com/keys
 *   GEMINI_API_KEY — https://aistudio.google.com/app/apikey  (tùy chọn)
 */

const SYSTEM_PROMPT = `Bạn là TechBot — trợ lý AI chuyên về tài liệu kỹ thuật, bản vẽ CAD (DWG/DXF), sơ đồ P&ID, file Excel vật tư và hồ sơ kỹ thuật.

Hãy:
- Trả lời bằng tiếng Việt, rõ ràng và chuyên nghiệp
- Dùng bullet points, số liệu cụ thể khi có thể
- Nếu được hỏi về file cụ thể mà chưa có nội dung, hãy hướng dẫn user upload
- Không bịa đặt số liệu kỹ thuật

Lĩnh vực chuyên môn: xây dựng, cơ khí, điện, kết cấu, vật tư công trình.`;

export default async function handler(req, res) {
  // CORS headers (cho phép test local)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages = [], fileName = null } = req.body || {};

  if (!messages.length) {
    return res.status(400).json({ error: 'messages là bắt buộc' });
  }

  // ── Chọn engine ──
  // Nếu fileName là ảnh/PDF → thử Gemini; còn lại dùng Groq
  const isVisionFile = fileName && /\.(png|jpg|jpeg|gif|webp|pdf)$/i.test(fileName);
  const useGemini    = isVisionFile && !!process.env.GEMINI_API_KEY;

  try {
    let reply, engine;

    if (useGemini) {
      ({ reply, engine } = await callGemini(messages, fileName));
    } else {
      ({ reply, engine } = await callGroq(messages, fileName));
    }

    return res.status(200).json({ reply, engine });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ── Groq (llama-3.3-70b-versatile) ──
async function callGroq(messages, fileName) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY chưa được cấu hình trên Vercel');

  const groqMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map(m => ({
      role: m.role,
      content: m.content
    }))
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: groqMessages,
      max_tokens: 1024,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq API lỗi: ${response.status}`);
  }

  const data = await response.json();
  return {
    reply: data.choices?.[0]?.message?.content || '(Không có phản hồi)',
    engine: 'groq'
  };
}

// ── Gemini Flash (cho vision/PDF) ──
async function callGemini(messages, fileName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY chưa được cấu hình');

  // Lấy message cuối của user
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const prompt = lastUserMsg?.content || '';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `${SYSTEM_PROMPT}\n\nUser: ${prompt}` }]
        }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      })
    }
  );

  if (!response.ok) {
    // Fallback sang Groq nếu Gemini lỗi
    return callGroq(messages, fileName);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return {
    reply: text || '(Không có phản hồi)',
    engine: 'gemini'
  };
}

/**
 * TechBot — Vercel Serverless Function
 * POST /api/chat
 *
 * Dùng Groq (llama3-70b) cho text, tự động fallback Gemini Flash nếu có file ảnh.
 * Biến môi trường cần set trên Vercel:
 *   GROQ_API_KEY   — https://console.groq.com/keys
 *   GEMINI_API_KEY — https://aistudio.google.com/app/apikey  (tùy chọn)
 */

import { createEmbedding, searchDocuments } from './embed.js';

const BASE_SYSTEM_PROMPT = `Bạn là TechBot — trợ lý AI chuyên về tài liệu kỹ thuật, bản vẽ CAD (DWG/DXF), sơ đồ P&ID, file Excel vật tư và hồ sơ kỹ thuật.

Hãy:
- Trả lời bằng tiếng Việt, rõ ràng và chuyên nghiệp
- Dùng bullet points, số liệu cụ thể khi có thể
- Nếu được hỏi về file cụ thể mà chưa có nội dung, hãy hướng dẫn user upload
- Không bịa đặt số liệu kỹ thuật

Lĩnh vực chuyên môn: xây dựng, cơ khí, điện, kết cấu, vật tư công trình.

QUY TẮC TRỢ LÝ CHỦ ĐỘNG:
- Nếu câu hỏi ngắn/chung chung (ví dụ chỉ là tên thiết bị), hãy tóm tắt nhanh những gì tìm được rồi hỏi lại: "Bạn muốn tìm hiểu thêm về khía cạnh nào?" thay vì đổ toàn bộ thông tin.
- Nếu tài liệu tham khảo đến từ nhiều file khác nhau, hãy chủ động đề cập: "Tôi tìm thấy thông tin từ X file liên quan..."
- Cuối mỗi câu trả lời có dùng tài liệu, LUÔN thêm dòng gợi ý theo định dạng CHÍNH XÁC sau (không thay đổi format):
💡 GỢI Ý: [câu gợi ý 1] | [câu gợi ý 2] | [câu gợi ý 3]
  (tối đa 3 gợi ý, ngắn gọn dưới 8 từ mỗi cái, liên quan trực tiếp đến nội dung vừa trả lời)
- Với tin nhắn chào hỏi hoặc không liên quan tài liệu: KHÔNG thêm dòng 💡 GỢI Ý.`;

function getSystemPrompt(roleContext, roleName) {
  if (!roleContext) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

VAI TRÒ HIỆN TẠI: ${roleName || 'Kỹ sư'}
${roleContext}

Hãy điều chỉnh phong cách trả lời phù hợp với vai trò này.`;
}

async function getRagContext(userMessage, project) {
  try {
    const embedding = await createEmbedding(userMessage);
    const chunks = await searchDocuments(embedding, project || null);
    if (!chunks || chunks.length === 0) return { contextBlock: '', citations: [] };

    const citations = chunks.map((c, i) => ({
      num: i + 1,
      file: c.file_name,
      page: c.page,
      type: c.chunk_type,
      text: c.chunk_text,
      image_url: c.image_url || null
    }));

    const uniqueFiles = [...new Set(citations.map(c => c.file))];
    const filesSummary = uniqueFiles.length > 1
      ? `Tìm thấy thông tin từ ${uniqueFiles.length} file: ${uniqueFiles.join(', ')}.`
      : `Tìm thấy thông tin từ file: ${uniqueFiles[0]}.`;

    const contextBlock = `\n\n=== TÀI LIỆU THAM KHẢO ===\n${filesSummary}\n\n${
      citations.map(c =>
        `[${c.num}] ${c.file}${c.page ? ` – trang ${c.page}` : ''}${c.type === 'image' ? ' [HÌNH ẢNH]' : ''}\n${c.text}`
      ).join('\n\n')
    }\n=== HẾT TÀI LIỆU ===\nTrích dẫn [số] sau câu sử dụng thông tin từ nguồn đó.`;

    return { contextBlock, citations };
  } catch (e) {
    console.error('RAG error:', e.message);
    return { contextBlock: '', citations: [] };
  }
}

export default async function handler(req, res) {
  // CORS headers (cho phép test local)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages = [], fileName = null, roleContext = null, roleName = null, project = null } = req.body || {};

  if (!messages.length) {
    return res.status(400).json({ error: 'messages là bắt buộc' });
  }

  // ── Chọn engine ──
  // Nếu fileName là ảnh/PDF → thử Gemini; còn lại dùng Groq
  const isVisionFile = fileName && /\.(png|jpg|jpeg|gif|webp|pdf)$/i.test(fileName);
  const useGemini    = isVisionFile && !!process.env.GEMINI_API_KEY;

  try {
    // RAG: tìm context từ tài liệu đã index
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const { contextBlock, citations } = await getRagContext(lastUserMsg, project);

    // Inject context vào messages nếu có
    let augmentedMessages = messages;
    if (contextBlock) {
      augmentedMessages = messages.map((m, i) => {
        if (i === messages.length - 1 && m.role === 'user') {
          return { ...m, content: m.content + contextBlock };
        }
        return m;
      });
    }

    let reply, engine;
    if (useGemini) {
      ({ reply, engine } = await callGemini(augmentedMessages, fileName, roleContext, roleName));
    } else {
      ({ reply, engine } = await callGroq(augmentedMessages, fileName, roleContext, roleName));
    }

    return res.status(200).json({ reply, engine, citations, chunks_used: citations.length });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ── Groq (llama-3.3-70b-versatile) ──
async function callGroq(messages, fileName, roleContext, roleName) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY chưa được cấu hình trên Vercel');

  const systemPrompt = getSystemPrompt(roleContext, roleName);
  const groqMessages = [
    { role: 'system', content: systemPrompt },
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
async function callGemini(messages, fileName, roleContext, roleName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY chưa được cấu hình');

  const systemPrompt = getSystemPrompt(roleContext, roleName);
  
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
          parts: [{ text: `${systemPrompt}\n\nUser: ${prompt}` }]
        }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      })
    }
  );

  if (!response.ok) {
    // Fallback sang Groq nếu Gemini lỗi
    return callGroq(messages, fileName, roleContext, roleName);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return {
    reply: text || '(Không có phản hồi)',
    engine: 'gemini'
  };
}

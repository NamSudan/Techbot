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

async function getRagContext(userMessage, project, geminiKey) {
  try {
    const embedding = await createEmbedding(userMessage, geminiKey);
    const chunks = await searchDocuments(embedding, project || null);
    if (!chunks || chunks.length === 0) return { contextBlock: '', citations: [], failedImages: 0 };

    const citations = chunks.map((c, i) => ({
      num: i + 1,
      file: c.file_name,
      page: c.page,
      type: c.chunk_type,
      text: c.chunk_text,
      image_url: c.image_url || null
    }));

    const failedImages = citations.filter(c =>
      c.type === 'image' && c.text && c.text.includes('Không đọc được hình')
    ).length;

    const uniqueFiles = [...new Set(citations.map(c => c.file))];
    const filesSummary = uniqueFiles.length > 1
      ? `Tìm thấy thông tin từ ${uniqueFiles.length} file: ${uniqueFiles.join(', ')}.`
      : `Tìm thấy thông tin từ file: ${uniqueFiles[0]}.`;

    let contextBlock = `\n\n=== TÀI LIỆU THAM KHẢO ===\n${filesSummary}\n\n${
      citations.map(c =>
        `[${c.num}] ${c.file}${c.page ? ` – trang ${c.page}` : ''}${c.type === 'image' ? ' [HÌNH ẢNH]' : ''}\n${c.text}`
      ).join('\n\n')
    }\n=== HẾT TÀI LIỆU ===\nTrích dẫn [số] sau câu sử dụng thông tin từ nguồn đó.`;

    if (failedImages > 0 && !geminiKey) {
      contextBlock += `\n\n[LƯU Ý HỆ THỐNG: ${failedImages} hình ảnh trong tài liệu chưa được đọc do thiếu Gemini API key. Hãy thông báo cho user rằng để xem nội dung hình ảnh, họ cần nhập Gemini API key vào mục Cài đặt (góc trái sidebar). Key miễn phí tại aistudio.google.com]`;
    }

    return { contextBlock, citations, failedImages };
  } catch (e) {
    console.error('RAG error:', e.message);
    return { contextBlock: '', citations: [], failedImages: 0 };
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

  const {
    messages = [], fileName = null, roleContext = null, roleName = null, project = null,
    userKeys = {}
  } = req.body || {};

  // Ưu tiên key từ user, fallback về env var
  const groqKey   = userKeys.groq   || process.env.GROQ_API_KEY;
  const geminiKey = userKeys.gemini || process.env.GEMINI_API_KEY;

  if (!messages.length) {
    return res.status(400).json({ error: 'messages là bắt buộc' });
  }

  // Nếu fileName là ảnh/PDF → thử Gemini; còn lại dùng Groq
  const isVisionFile = fileName && /\.(png|jpg|jpeg|gif|webp|pdf)$/i.test(fileName);
  const useGemini    = isVisionFile && !!geminiKey;

  try {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const { contextBlock, citations, failedImages } = await getRagContext(lastUserMsg, project, geminiKey);

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
      ({ reply, engine } = await callGemini(augmentedMessages, fileName, roleContext, roleName, geminiKey, groqKey));
    } else {
      ({ reply, engine } = await callGroq(augmentedMessages, fileName, roleContext, roleName, groqKey));
    }

    return res.status(200).json({ reply, engine, citations, chunks_used: citations.length, failedImages });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

function groqApiError(status, message) {
  if (status === 429) return new Error('RATE_LIMIT: Groq API key đã vượt quota. Thử lại sau ít phút hoặc nhập key riêng trong Cài đặt.');
  if (status === 401 || status === 403) return new Error('INVALID_KEY: Groq API key không hợp lệ. Vui lòng kiểm tra lại trong Cài đặt.');
  return new Error(message || `Groq API lỗi: ${status}`);
}

function geminiApiError(status, message) {
  if (status === 429) return new Error('RATE_LIMIT: Gemini API key đã vượt quota. Thử lại sau ít phút hoặc nhập key riêng trong Cài đặt.');
  if (status === 401 || status === 403) return new Error('INVALID_KEY: Gemini API key không hợp lệ. Vui lòng kiểm tra lại trong Cài đặt.');
  return new Error(message || `Gemini API lỗi: ${status}`);
}

// ── Groq (llama-3.3-70b-versatile) ──
async function callGroq(messages, fileName, roleContext, roleName, groqKey) {
  const apiKey = groqKey;
  if (!apiKey) throw new Error('Thiếu Groq API key — vào Cài đặt để nhập key của bạn');

  const systemPrompt = getSystemPrompt(roleContext, roleName);
  const groqMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: groqMessages, max_tokens: 1024, temperature: 0.7 })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw groqApiError(response.status, err.error?.message);
  }

  const data = await response.json();
  return { reply: data.choices?.[0]?.message?.content || '(Không có phản hồi)', engine: 'groq' };
}

// ── Gemini Flash ──
async function callGemini(messages, fileName, roleContext, roleName, geminiKey, groqKey) {
  const apiKey = geminiKey;
  if (!apiKey) throw new Error('Thiếu Gemini API key — vào Cài đặt để nhập key của bạn');

  const systemPrompt = getSystemPrompt(roleContext, roleName);
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const prompt = lastUserMsg?.content || '';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${prompt}` }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      })
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const apiErr = geminiApiError(response.status, err.error?.message);
    // Fallback sang Groq chỉ khi lỗi không phải key/quota
    if (response.status !== 429 && response.status !== 401 && response.status !== 403) {
      return callGroq(messages, fileName, roleContext, roleName, groqKey);
    }
    throw apiErr;
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return { reply: text || '(Không có phản hồi)', engine: 'gemini' };
}

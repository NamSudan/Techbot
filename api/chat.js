import { createEmbedding, searchDocuments, classifyIntent, fetchSectionChunks } from './embed.js';
import { TOOL_SCHEMAS, executeTool } from './tools.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const BASE_SYSTEM_PROMPT = `Bạn là TechBot — trợ lý AI chuyên về tài liệu kỹ thuật, bản vẽ CAD (DWG/DXF), sơ đồ P&ID, file Excel vật tư và hồ sơ kỹ thuật.

NGÔN NGỮ: Luôn trả lời bằng tiếng Việt dù câu hỏi hay tài liệu bằng tiếng Anh hay ngôn ngữ khác. Dịch thông tin kỹ thuật từ tài liệu sang tiếng Việt khi trích dẫn.

Hãy:
- Trả lời rõ ràng và chuyên nghiệp
- Dùng bullet points, số liệu cụ thể khi có thể
- Nếu được hỏi về file cụ thể mà chưa có nội dung, hãy hướng dẫn user upload
- Không bịa đặt số liệu kỹ thuật

Lĩnh vực chuyên môn: xây dựng, cơ khí, điện, kết cấu, vật tư công trình.

QUY TẮC HỎI LẠI:
- Nếu câu hỏi kỹ thuật thiếu thông số quan trọng không thể đoán (ví dụ: "tính tải trọng" mà không biết loại tải, kết cấu, tiêu chuẩn), hãy đặt PREFIX "CLARIF::" vào ĐẦU reply và hỏi lại thay vì đoán.
- Ví dụ: "CLARIF::Để tính tải trọng chính xác, bạn cho tôi biết: (1) loại tải (tĩnh/động/gió)? (2) kết cấu gì (dầm/cột/mái)? (3) tiêu chuẩn thiết kế (TCVN/Eurocode/ACI)?"
- CHỈ dùng CLARIF:: khi thực sự thiếu thông số bắt buộc. Với câu hỏi đủ rõ, trả lời ngay.

QUY TẮC TOOLS:
- Dùng tool "calculate" khi cần tính toán số liệu (diện tích, tải trọng, chuyển đổi công thức)
- Dùng tool "convert_unit" khi cần đổi đơn vị (PSI→MPa, inch→mm, hp→kW...)
- Dùng tool "search_technical_standard" khi hỏi tiêu chuẩn mà tài liệu không có
- Dùng tool "rag_search" khi cần tra cứu thêm khía cạnh cụ thể trong tài liệu
- Tích hợp kết quả tool tự nhiên vào câu trả lời, không hiển thị raw output của tool

QUY TẮC HIỂN THỊ HÌNH ẢNH:
- Khi câu trả lời cần hình ảnh minh hoạ, chèn [IMG:N] vào đúng vị trí trong text (N là số của citation HÌNH ẢNH)
- Chỉ dùng [IMG:N] khi thực sự cần — không dùng nếu câu hỏi chỉ cần text
- [IMG:N][IMG:M] viết liền nhau = hiển thị 2 ảnh song song để so sánh

QUY TẮC TRỢ LÝ CHỦ ĐỘNG:
- Nếu câu hỏi ngắn/chung chung, tóm tắt nhanh rồi hỏi lại: "Bạn muốn tìm hiểu thêm về khía cạnh nào?"
- Nếu tài liệu từ nhiều file, chủ động đề cập: "Tôi tìm thấy thông tin từ X file liên quan..."
- Cuối mỗi câu trả lời có dùng tài liệu, LUÔN thêm dòng gợi ý CHÍNH XÁC format sau:
💡 GỢI Ý: [câu gợi ý 1] | [câu gợi ý 2] | [câu gợi ý 3]
  (tối đa 3 gợi ý, ngắn gọn dưới 8 từ mỗi cái, liên quan trực tiếp đến nội dung vừa trả lời)
- Với tin nhắn chào hỏi hoặc không liên quan tài liệu: KHÔNG thêm dòng 💡 GỢI Ý.`;

function getSystemPrompt(roleContext, roleName, memories = []) {
  let prompt = BASE_SYSTEM_PROMPT;

  if (memories.length > 0) {
    const memLines = memories.map(m => `- [${m.memory_type}] ${m.content}`).join('\n');
    prompt += `\n\n=== THÔNG TIN GHI NHỚ VỀ NGƯỜI DÙNG ===\n${memLines}\n=== HẾT GHI NHỚ ===\nSử dụng thông tin này để cá nhân hoá câu trả lời khi phù hợp.`;
  }

  if (roleContext) {
    prompt += `\n\nVAI TRÒ HIỆN TẠI: ${roleName || 'Người dùng'}\n${roleContext}\n\nHãy điều chỉnh phong cách trả lời phù hợp với vai trò này.`;
  }

  return prompt;
}

async function getUserMemories(userId, project) {
  if (!userId || !SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
    const pf = project
      ? `user_id=eq.${encodeURIComponent(userId)}&project=eq.${encodeURIComponent(project)}`
      : `user_id=eq.${encodeURIComponent(userId)}&project=is.null`;
    const cf = `user_id=eq.${encodeURIComponent(userId)}&project=is.null`;
    const order = '&order=importance.desc,accessed_at.desc&limit=15';

    const [pRows, cRows] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/user_memories?${pf}${order}`, { headers }).then(r => r.ok ? r.json() : []),
      project ? fetch(`${SUPABASE_URL}/rest/v1/user_memories?${cf}${order}`, { headers }).then(r => r.ok ? r.json() : []) : []
    ]);

    const seen = new Set();
    return [...pRows, ...cRows].filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; }).slice(0, 20);
  } catch {
    return [];
  }
}

// Fire-and-forget: extract facts from turn and save as memories
async function extractAndSaveMemories(userId, project, userMsg, botReply, groqKey) {
  if (!userId || !groqKey || botReply.length < 100) return;
  try {
    const extractPrompt = `Từ cuộc hội thoại sau, trích xuất tối đa 3 thông tin quan trọng về người dùng (sở thích, nghề nghiệp, tiêu chuẩn hay dùng, thiết bị hay dùng, v.v.) để lưu làm memory cá nhân hoá.

User nói: "${userMsg.slice(0, 500)}"
Bot trả lời: "${botReply.slice(0, 300)}"

Trả về JSON object với key "memories" là array, mỗi phần tử có: { "content": "...", "memory_type": "fact|preference|context|correction", "importance": 1-10 }
Nếu không có thông tin đáng lưu, trả về {"memories": []}`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: extractPrompt }],
        max_tokens: 200,
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) return;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{"memories":[]}');
    const mems = (parsed.memories || []).slice(0, 3);

    for (const m of mems) {
      if (!m.content) continue;
      await fetch(`${SUPABASE_URL}/rest/v1/user_memories`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          user_id: userId,
          project: project || null,
          memory_type: m.memory_type || 'fact',
          content: String(m.content).slice(0, 500),
          importance: Math.min(10, Math.max(1, m.importance || 5)),
          source_msg: userMsg.slice(0, 200)
        })
      });
    }
  } catch {
    // Never throw from fire-and-forget
  }
}

async function getRagContext(userMessage, project, geminiKey) {
  try {
    const embedding = await createEmbedding(userMessage, geminiKey);
    const intent = classifyIntent(userMessage);
    let chunks = await searchDocuments(embedding, project || null, intent);
    if (!chunks || chunks.length === 0) return { contextBlock: '', citations: [], failedImages: 0, intent };

    if (intent === 'detail') {
      chunks = await fetchSectionChunks(chunks, project || null);
    }

    const citations = chunks.map((c, i) => ({
      num: i + 1,
      file: c.file_name,
      page: c.page,
      type: c.chunk_type,
      text: c.chunk_text,
      image_url: c.image_url || null,
      section_title: c.section_title || null,
      surrounding_text: c.surrounding_text || null
    }));

    const failedImages = citations.filter(c => c.type === 'image' && c.text && c.text.includes('Không đọc được hình')).length;
    const uniqueFiles = [...new Set(citations.map(c => c.file))];
    const filesSummary = uniqueFiles.length > 1
      ? `Tìm thấy thông tin từ ${uniqueFiles.length} file: ${uniqueFiles.join(', ')}.`
      : `Tìm thấy thông tin từ file: ${uniqueFiles[0]}.`;

    const citationLines = citations.map(c => {
      const sectionTag = c.section_title ? ` [Mục: ${c.section_title}]` : '';
      const pageTag    = c.page ? ` – trang ${c.page}` : '';
      const typeTag    = c.type === 'image' ? ' [HÌNH ẢNH — dùng [IMG:N] nếu cần hiển thị]' : '';
      const contextNote = c.type === 'image' && c.surrounding_text ? `\nNgữ cảnh: "${c.surrounding_text}"` : '';
      return `[${c.num}] ${c.file}${pageTag}${sectionTag}${typeTag}\n${c.text}${contextNote}`;
    }).join('\n\n');

    let contextBlock = `\n\n=== TÀI LIỆU THAM KHẢO ===\n${filesSummary}\n\n${citationLines}\n=== HẾT TÀI LIỆU ===
Hướng dẫn trả lời:
- Trích dẫn [số] sau câu dùng thông tin từ nguồn đó
- Nếu câu hỏi yêu cầu hình ảnh minh hoạ, chèn [IMG:N] vào đúng vị trí trong câu trả lời (chỉ với citation là HÌNH ẢNH)`;

    if (failedImages > 0 && !geminiKey) {
      contextBlock += `\n\n[LƯU Ý HỆ THỐNG: ${failedImages} hình ảnh chưa được đọc do thiếu Gemini API key. Hãy thông báo user nhập Gemini API key trong Cài đặt.]`;
    }

    return { contextBlock, citations, failedImages, intent };
  } catch (e) {
    console.error('RAG error:', e.message);
    return { contextBlock: '', citations: [], failedImages: 0, intent: 'detail' };
  }
}

// Agentic loop: up to 3 tool-call iterations
async function callGroqWithTools(messages, roleContext, roleName, groqKey, geminiKey, project, userId) {
  if (!groqKey) throw new Error('Thiếu Groq API key — vào Cài đặt để nhập key của bạn');

  const memories = await getUserMemories(userId, project);
  const systemPrompt = getSystemPrompt(roleContext, roleName, memories);
  const toolContext = { project, geminiKey };

  let groqMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ];

  const toolResults = [];
  const MAX_ITERATIONS = 3;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const isLastIter = iter === MAX_ITERATIONS - 1;
    const body = {
      model: 'llama-3.3-70b-versatile',
      messages: groqMessages,
      max_tokens: isLastIter ? 1500 : 800,
      temperature: 0.7
    };
    if (!isLastIter) {
      body.tools = TOOL_SCHEMAS;
      body.tool_choice = 'auto';
    }

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw groqApiError(res.status, err.error?.message);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const assistantMsg = choice?.message;

    if (!assistantMsg) break;

    // No tool calls — final answer
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      let reply = assistantMsg.content || '(Không có phản hồi)';
      const isClarification = reply.startsWith('CLARIF::');
      if (isClarification) reply = reply.slice('CLARIF::'.length).trim();
      return { reply, engine: 'groq', toolResults, isClarification };
    }

    // Execute tool calls
    groqMessages.push(assistantMsg);
    for (const tc of assistantMsg.tool_calls) {
      let toolOutput;
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        toolOutput = await executeTool(tc.function.name, args, toolContext);
        toolResults.push({ name: tc.function.name, result: toolOutput });
      } catch (e) {
        toolOutput = `Lỗi tool ${tc.function.name}: ${e.message}`;
      }
      groqMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolOutput });
    }
  }

  return { reply: '(Không có phản hồi)', engine: 'groq', toolResults, isClarification: false };
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

async function callGemini(messages, fileName, roleContext, roleName, geminiKey, groqKey) {
  if (!geminiKey) throw new Error('Thiếu Gemini API key — vào Cài đặt để nhập key của bạn');
  const systemPrompt = getSystemPrompt(roleContext, roleName);
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const prompt = lastUserMsg?.content || '';

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
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
    if (response.status !== 429 && response.status !== 401 && response.status !== 403) {
      const result = await callGroqWithTools(messages, roleContext, roleName, groqKey, geminiKey, null, null);
      return result;
    }
    throw apiErr;
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return { reply: text || '(Không có phản hồi)', engine: 'gemini', toolResults: [], isClarification: false };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    messages = [], fileName = null, roleContext = null, roleName = null, project = null,
    userKeys = {}, userId = null
  } = req.body || {};

  const groqKey   = userKeys.groq   || process.env.GROQ_API_KEY;
  const geminiKey = userKeys.gemini || process.env.GEMINI_API_KEY;

  if (!messages.length) return res.status(400).json({ error: 'messages là bắt buộc' });

  const isVisionFile = fileName && /\.(png|jpg|jpeg|gif|webp|pdf)$/i.test(fileName);

  try {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const { contextBlock, citations, failedImages, intent } = await getRagContext(lastUserMsg, project, geminiKey);

    const hasImageCitations = citations.some(c => c.type === 'image' && c.image_url);
    const useGemini = ((isVisionFile || hasImageCitations) && !!geminiKey);

    let augmentedMessages = messages;
    if (contextBlock) {
      augmentedMessages = messages.map((m, i) => {
        if (i === messages.length - 1 && m.role === 'user') {
          return { ...m, content: m.content + contextBlock };
        }
        return m;
      });
    }

    let reply, engine, toolResults = [], isClarification = false;

    if (useGemini) {
      ({ reply, engine, toolResults, isClarification } = await callGemini(augmentedMessages, fileName, roleContext, roleName, geminiKey, groqKey));
    } else {
      ({ reply, engine, toolResults, isClarification } = await callGroqWithTools(augmentedMessages, roleContext, roleName, groqKey, geminiKey, project, userId));
    }

    // Fire-and-forget memory extraction (never blocks response)
    if (userId && !isClarification) {
      extractAndSaveMemories(userId, project, lastUserMsg, reply, groqKey).catch(() => {});
    }

    return res.status(200).json({ reply, engine, citations, chunks_used: citations.length, failedImages, intent, is_clarification: isClarification, toolResults });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

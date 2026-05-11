/**
 * TechBot — Embedding + Vector Search via Supabase
 * Dùng Gemini text-embedding-004 (768 chiều)
 */

function geminiApiError(status, message) {
  if (status === 429) return new Error(`RATE_LIMIT: Gemini API key đã vượt quota. Thử lại sau ít phút hoặc dùng key riêng trong Cài đặt.`);
  if (status === 401 || status === 403) return new Error(`INVALID_KEY: Gemini API key không hợp lệ hoặc không có quyền truy cập.`);
  return new Error(message || `Gemini Embed lỗi: ${status}`);
}

// Tạo embedding từ text dùng Gemini
export async function createEmbedding(text, geminiKey) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Thiếu GEMINI_API_KEY — vào Cài đặt để nhập key của bạn');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: text.slice(0, 2000) }] },
        outputDimensionality: 768
      })
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw geminiApiError(response.status, err.error?.message);
  }

  const data = await response.json();
  return data.embedding?.values || [];
}

// Tìm chunks liên quan trong Supabase
export async function searchDocuments(queryEmbedding, project = null, topK = 5) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return [];

  const body = {
    query_embedding: queryEmbedding,
    match_count: topK
  };
  if (project) body.filter_project = project;

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/match_documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) return [];
  return await response.json();
}

// Lưu chunks vào Supabase
export async function saveChunks(chunks) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) throw new Error('Thiếu Supabase config');

  const response = await fetch(`${supabaseUrl}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(chunks)
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `Supabase insert lỗi: ${response.status}`);
  }
  return true;
}

// Chia text thành chunks
export function chunkText(text, chunkSize = 600, overlap = 100) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let buffer = '';

  for (const para of paragraphs) {
    if ((buffer + para).length > chunkSize) {
      if (buffer.trim()) {
        chunks.push(buffer.trim());
        buffer = buffer.slice(-overlap);
      }
    }
    buffer += (buffer ? '\n\n' : '') + para;
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

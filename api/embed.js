/**
 * TechBot — Embedding + Vector Search via Supabase
 * Dùng Gemini text-embedding-004 (768 chiều)
 */

function geminiApiError(status, message) {
  if (status === 429) return new Error(`RATE_LIMIT: Gemini API key đã vượt quota. Thử lại sau ít phút hoặc dùng key riêng trong Cài đặt.`);
  if (status === 401 || status === 403) return new Error(`INVALID_KEY: Gemini API key không hợp lệ hoặc không có quyền truy cập.`);
  return new Error(message || `Gemini Embed lỗi: ${status}`);
}

// Tạo embedding từ text dùng Gemini text-embedding-004
export async function createEmbedding(text, geminiKey) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Thiếu GEMINI_API_KEY — vào Cài đặt để nhập key của bạn');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
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

// Phân loại intent: 'overview' (tổng quan) hoặc 'detail' (chi tiết)
export function classifyIntent(userMessage) {
  const lower = userMessage.toLowerCase();
  const overviewPatterns = [
    'tóm tắt', 'tổng quan', 'toàn bộ', 'overview', 'giới thiệu', 'khái quát',
    'nêu tất cả', 'liệt kê', 'danh sách', 'tổng hợp', 'summary',
    'nội dung chính', 'điểm chính', 'những gì', 'có những', 'gồm những',
    'bao gồm những', 'nêu các', 'cho biết tất cả', 'toàn bộ nội dung',
    'tất cả các', 'các bước chính', 'các phần', 'có mấy', 'gồm mấy'
  ];
  return overviewPatterns.some(p => lower.includes(p)) ? 'overview' : 'detail';
}

// Tìm chunks liên quan trong Supabase với dynamic topK theo intent
export async function searchDocuments(queryEmbedding, project = null, intent = 'detail') {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return [];

  const topK = intent === 'overview' ? 20 : 5;

  const body = { query_embedding: queryEmbedding, match_count: topK };
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

// Section-aware: bổ sung các chunks cùng section với kết quả top-K
// Giúp tránh mất context khi chunk match nằm giữa một section dài
export async function fetchSectionChunks(chunks, project) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return chunks;

  // Collect unique (file_name, section_title) pairs có section
  const pairs = [];
  const seen = new Set();
  for (const c of chunks) {
    if (!c.section_title) continue;
    const key = `${c.file_name}||${c.section_title}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ file_name: c.file_name, section_title: c.section_title });
    }
  }

  if (pairs.length === 0) return chunks;

  // Fetch tất cả chunks của từng section song song
  const fetches = pairs.map(({ file_name, section_title }) => {
    const params = new URLSearchParams();
    params.set('file_name', `eq.${file_name}`);
    params.set('section_title', `eq.${section_title}`);
    params.set('select', 'id,file_name,chunk_text,chunk_type,image_url,page,project,role,section_title,section_index,doc_position,surrounding_text');
    params.set('order', 'doc_position.asc');
    if (project) params.set('project', `eq.${project}`);

    return fetch(`${supabaseUrl}/rest/v1/documents?${params}`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    }).then(r => r.ok ? r.json() : []).catch(() => []);
  });

  const sectionResults = (await Promise.all(fetches)).flat();

  // Merge: giữ nguyên top-K, thêm chunks cùng section chưa có
  const existingIds = new Set(chunks.map(c => c.id));
  const extra = sectionResults.filter(c => !existingIds.has(c.id));

  // Cap tổng ở 20 chunks để tránh context quá dài
  return [...chunks, ...extra].slice(0, 20);
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

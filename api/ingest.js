/**
 * TechBot — Ingest API
 * POST /api/ingest
 * Nhận { fileName, fileBase64, mimeType, project, role }
 * → Extract text inline (no self-call) → Chunk → Embed → Lưu Supabase
 */

import { createEmbedding, saveChunks, chunkText } from './embed.js';

const VISION_PROMPT_IMAGE = `Hãy phân tích hình ảnh kỹ thuật này và trích xuất TOÀN BỘ:
1. Tất cả văn bản, số liệu, kích thước có trong ảnh
2. Mô tả sơ đồ, bản vẽ, biểu đồ nếu có
3. Bảng biểu và dữ liệu trong bảng
4. Ký hiệu kỹ thuật, chú thích, ghi chú
Trả về text có cấu trúc rõ ràng.`;

const VISION_PROMPT_PDF = `Đây là tài liệu kỹ thuật PDF. Hãy trích xuất TOÀN BỘ nội dung:
1. Tất cả văn bản theo đúng thứ tự
2. Nội dung bảng biểu (giữ nguyên cấu trúc)
3. Số liệu, kích thước, thông số kỹ thuật
4. Mô tả hình ảnh, sơ đồ, bản vẽ nếu có
5. Chú thích, ghi chú, footnote
Trả về text đầy đủ, có cấu trúc.`;

async function callGeminiVision(base64Data, mimeType, prompt, geminiKey, retries = 3) {
  const apiKey = geminiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Thiếu Gemini API key — vào Cài đặt để nhập key của bạn');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64Data } },
              { text: prompt }
            ]
          }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.1 }
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `Gemini lỗi ${response.status}`;

    if (response.status === 429 || response.status >= 500) {
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[Gemini] ${msg} — retry ${attempt + 1}/${retries} sau ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`RATE_LIMIT: Gemini API key đã vượt quota. Thử lại sau ít phút.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`INVALID_KEY: Gemini API key không hợp lệ. Kiểm tra lại trong Cài đặt.`);
    }
    throw new Error(msg);
  }
}

async function uploadImageToSupabase(base64Data, fileName, pageNum, imgIndex) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return null;

  const path = `${fileName}/${pageNum}_${imgIndex}.jpg`;
  const imageBuffer = Buffer.from(base64Data, 'base64');

  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/techbot-images/${path}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true'
      },
      body: imageBuffer
    }
  );

  if (!response.ok) return null;
  return `${supabaseUrl}/storage/v1/object/public/techbot-images/${path}`;
}

function extractPdfTextRaw(buffer) {
  try {
    const str = buffer.toString('latin1');
    const texts = [];
    const btMatches = str.matchAll(/BT\s*([\s\S]*?)\s*ET/g);
    for (const m of btMatches) {
      const tjMatches = m[1].matchAll(/\((.*?)\)\s*Tj/g);
      for (const tj of tjMatches) {
        const t = tj[1]
          .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
          .replace(/\\\\/g, '\\')
          .replace(/\\n/g, '\n');
        if (t.trim()) texts.push(t);
      }
    }
    const result = texts.join(' ').slice(0, 8000);
    return result || '[PDF không có text layer — thêm GEMINI_API_KEY để đọc hình ảnh/scan]';
  } catch {
    return '[Không đọc được PDF]';
  }
}

// Extract all <w:t> text nodes from DOCX XML, including text boxes
async function extractDocxXmlText(buffer) {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buffer);
    const xmlSources = ['word/document.xml', 'word/header1.xml', 'word/header2.xml',
      'word/footer1.xml', 'word/footer2.xml'];
    const parts = [];
    for (const src of xmlSources) {
      if (zip.files[src]) {
        const xml = await zip.files[src].async('string');
        const matches = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
        parts.push(matches.map(m => m.replace(/<[^>]+>/g, '')).join(' '));
      }
    }
    return parts.join('\n').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

async function parseDocx(buffer, geminiKey, fileName) {
  const mammoth = (await import('mammoth')).default;
  let textContent = '';
  let imageObjects = [];

  try {
    const r = await mammoth.extractRawText({ buffer });
    textContent = r.value;
  } catch (e) {
    textContent = `[Lỗi đọc text DOCX: ${e.message}]`;
  }

  if (textContent.length < 100) {
    const xmlText = await extractDocxXmlText(buffer);
    if (xmlText.length > textContent.length) textContent = xmlText;
  }

  if (geminiKey) {
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(buffer);
      const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
      const imgFiles = Object.keys(zip.files).filter(name => {
        const e = name.split('.').pop().toLowerCase();
        return name.startsWith('word/media/') && imgExts.includes(e);
      });

      const limit = Math.min(imgFiles.length, 20);
      for (let i = 0; i < limit; i++) {
        const imgBuf = await zip.files[imgFiles[i]].async('nodebuffer');
        const imgB64 = imgBuf.toString('base64');
        const imgExt = imgFiles[i].split('.').pop().toLowerCase();
        const imgMime = `image/${imgExt === 'jpg' ? 'jpeg' : imgExt}`;
        try {
          const [desc, imageUrl] = await Promise.all([
            callGeminiVision(imgB64, imgMime, VISION_PROMPT_IMAGE, geminiKey),
            uploadImageToSupabase(imgB64, fileName, 1, i)
          ]);
          imageObjects.push({ description: desc, imageUrl, index: i });
        } catch (e) {
          console.warn(`[DOCX] Hình ${i + 1}:`, e.message);
          imageObjects.push({ description: `[Không đọc được hình ${i + 1}: ${e.message}]`, imageUrl: null, index: i });
        }
      }
    } catch (e) {
      console.warn('DOCX image extract error:', e.message);
    }
  }

  return { extractedText: textContent, imageObjects };
}

async function parseXlsx(buffer, geminiKey, fileName) {
  const XLSX = await import('xlsx');
  let textContent = '';
  let imageObjects = [];

  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const lines = [];
    workbook.SheetNames.forEach(sheetName => {
      const ws = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (csv.trim()) lines.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    });
    textContent = lines.join('\n\n');
  } catch (e) {
    textContent = `[Lỗi đọc XLSX: ${e.message}]`;
  }

  if (geminiKey) {
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(buffer);
      const imgFiles = Object.keys(zip.files).filter(name => {
        const e = name.split('.').pop().toLowerCase();
        return name.startsWith('xl/media/') && ['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(e);
      });

      const limit = Math.min(imgFiles.length, 20);
      for (let i = 0; i < limit; i++) {
        const imgBuf = await zip.files[imgFiles[i]].async('nodebuffer');
        const imgB64 = imgBuf.toString('base64');
        const imgExt = imgFiles[i].split('.').pop().toLowerCase();
        const imgMime = `image/${imgExt === 'jpg' ? 'jpeg' : imgExt}`;
        try {
          const [desc, imageUrl] = await Promise.all([
            callGeminiVision(imgB64, imgMime, VISION_PROMPT_IMAGE, geminiKey),
            uploadImageToSupabase(imgB64, fileName, 1, i)
          ]);
          imageObjects.push({ description: desc, imageUrl, index: i });
        } catch (e) {
          console.warn(`[XLSX] Hình ${i + 1}:`, e.message);
          imageObjects.push({ description: `[Không đọc được hình ${i + 1}: ${e.message}]`, imageUrl: null, index: i });
        }
      }
    } catch (e) {
      console.warn('XLSX image extract error:', e.message);
    }
  }

  return { extractedText: textContent, imageObjects };
}

async function extractText(fileName, fileBase64, mimeType, geminiKey) {
  const buffer = Buffer.from(fileBase64, 'base64');
  const ext = fileName.split('.').pop().toLowerCase();

  let extractedText = '';
  let imageObjects = [];

  if (['txt', 'csv', 'json', 'md', 'log'].includes(ext)) {
    extractedText = buffer.toString('utf-8');
  } else if (['docx', 'doc'].includes(ext)) {
    const r = await parseDocx(buffer, geminiKey, fileName);
    extractedText = r.extractedText;
    imageObjects = r.imageObjects;
  } else if (['xlsx', 'xls'].includes(ext)) {
    const r = await parseXlsx(buffer, geminiKey, fileName);
    extractedText = r.extractedText;
    imageObjects = r.imageObjects;
  } else if (ext === 'pdf') {
    if (geminiKey) {
      extractedText = await callGeminiVision(fileBase64, 'application/pdf', VISION_PROMPT_PDF, geminiKey);
    } else {
      extractedText = extractPdfTextRaw(buffer);
    }
  } else {
    extractedText = `[Loại .${ext} chưa hỗ trợ]`;
  }

  return { extractedText, imageObjects };
}

function recommendModel(ext, textChunks, imageChunks) {
  // File ảnh trực tiếp
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
    return { model: 'gemini', reason: 'File ảnh — cần Gemini Vision để phân tích nội dung', required: true };
  }
  // PDF — thường cần Vision
  if (ext === 'pdf') {
    if (textChunks === 0) return { model: 'gemini', reason: 'PDF scan/ảnh — không có text layer, cần Gemini Vision', required: true };
    return { model: 'gemini', reason: 'PDF có thể chứa sơ đồ/bảng — Gemini Vision cho kết quả tốt hơn', required: false };
  }
  // DOCX/XLSX có nhiều ảnh
  if (['docx', 'doc', 'xlsx', 'xls'].includes(ext) && imageChunks > 3) {
    return { model: 'gemini', reason: `Tài liệu có ${imageChunks} hình ảnh minh họa — Gemini Vision đọc được nội dung ảnh`, required: false };
  }
  // Văn bản thuần hoặc ít ảnh
  return { model: 'groq', reason: 'Tài liệu chủ yếu là text — Groq (Llama) nhanh và hiệu quả', required: false };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileName, fileBase64, mimeType, project = 'default', role = null, userKeys = {} } = req.body || {};
  if (!fileName || !fileBase64) {
    return res.status(400).json({ error: 'Thiếu fileName hoặc fileBase64' });
  }

  const geminiKey = userKeys.gemini || process.env.GEMINI_API_KEY;

  try {
    const rows = [];
    const ext = fileName.split('.').pop().toLowerCase();
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);

    if (isImage) {
      const description = await callGeminiVision(fileBase64, mimeType || `image/${ext}`, VISION_PROMPT_IMAGE, geminiKey);
      const imageUrl = await uploadImageToSupabase(fileBase64, fileName, 1, 0);
      const embedding = await createEmbedding(description, geminiKey);
      rows.push({
        file_name: fileName, project, role,
        page: 1, chunk_index: 0,
        chunk_type: 'image',
        chunk_text: description,
        image_url: imageUrl,
        embedding
      });
    } else {
      const { extractedText, imageObjects } = await extractText(fileName, fileBase64, mimeType, geminiKey);

      if (extractedText.trim()) {
        const chunks = chunkText(extractedText);
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await createEmbedding(chunks[i], geminiKey);
          rows.push({
            file_name: fileName, project, role,
            page: null, chunk_index: i,
            chunk_type: 'text',
            chunk_text: chunks[i],
            image_url: null,
            embedding
          });
        }
      }

      // Tạo chunk riêng cho mỗi ảnh nhúng — có image_url để hiển thị trong chat
      for (const img of imageObjects) {
        if (!img.description) continue;
        const embedding = await createEmbedding(img.description, geminiKey);
        rows.push({
          file_name: fileName, project, role,
          page: null, chunk_index: img.index,
          chunk_type: 'image',
          chunk_text: img.description,
          image_url: img.imageUrl,
          embedding
        });
      }
    }

    if (rows.length > 0) {
      await saveChunks(rows);
    }

    const imageChunks = rows.filter(r => r.chunk_type === 'image').length;
    const textChunks  = rows.filter(r => r.chunk_type === 'text').length;
    const recommendation = recommendModel(ext, textChunks, imageChunks);

    return res.status(200).json({
      ok: true,
      fileName,
      chunks: rows.length,
      method: isImage ? 'vision' : 'text',
      recommendation
    });

  } catch (err) {
    console.error('[Ingest Error]', err);
    return res.status(500).json({ error: err.message });
  }
}

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

async function callGeminiVision(base64Data, mimeType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Thiếu GEMINI_API_KEY');
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
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini lỗi ${response.status}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

async function parseDocx(buffer, hasGemini) {
  const mammoth = (await import('mammoth')).default;
  let textContent = '';
  let imageDescs = [];

  try {
    const r = await mammoth.extractRawText({ buffer });
    textContent = r.value.slice(0, 12000);
  } catch (e) {
    textContent = `[Lỗi đọc text DOCX: ${e.message}]`;
  }

  if (hasGemini) {
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(buffer);
      const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
      const imgFiles = Object.keys(zip.files).filter(name => {
        const e = name.split('.').pop().toLowerCase();
        return name.startsWith('word/media/') && imgExts.includes(e);
      });

      const limit = Math.min(imgFiles.length, 5);
      for (let i = 0; i < limit; i++) {
        const imgBuf = await zip.files[imgFiles[i]].async('nodebuffer');
        const imgB64 = imgBuf.toString('base64');
        const imgExt = imgFiles[i].split('.').pop().toLowerCase();
        const imgMime = `image/${imgExt === 'jpg' ? 'jpeg' : imgExt}`;
        try {
          const desc = await callGeminiVision(imgB64, imgMime, VISION_PROMPT_IMAGE);
          imageDescs.push(desc);
        } catch {
          imageDescs.push(`[Không đọc được hình ${i + 1}]`);
        }
      }
    } catch (e) {
      console.warn('DOCX image extract error:', e.message);
    }
  }

  return { extractedText: textContent, imageDescriptions: imageDescs };
}

async function parseXlsx(buffer, hasGemini) {
  const XLSX = await import('xlsx');
  let textContent = '';
  let imageDescs = [];

  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const lines = [];
    workbook.SheetNames.forEach(sheetName => {
      const ws = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (csv.trim()) lines.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    });
    textContent = lines.join('\n\n').slice(0, 12000);
  } catch (e) {
    textContent = `[Lỗi đọc XLSX: ${e.message}]`;
  }

  if (hasGemini) {
    try {
      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(buffer);
      const imgFiles = Object.keys(zip.files).filter(name => {
        const e = name.split('.').pop().toLowerCase();
        return name.startsWith('xl/media/') && ['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(e);
      });

      const limit = Math.min(imgFiles.length, 3);
      for (let i = 0; i < limit; i++) {
        const imgBuf = await zip.files[imgFiles[i]].async('nodebuffer');
        const imgB64 = imgBuf.toString('base64');
        const imgExt = imgFiles[i].split('.').pop().toLowerCase();
        const imgMime = `image/${imgExt === 'jpg' ? 'jpeg' : imgExt}`;
        try {
          const desc = await callGeminiVision(imgB64, imgMime, VISION_PROMPT_IMAGE);
          imageDescs.push(desc);
        } catch {
          imageDescs.push(`[Không đọc được hình ${i + 1}]`);
        }
      }
    } catch (e) {
      console.warn('XLSX image extract error:', e.message);
    }
  }

  return { extractedText: textContent, imageDescriptions: imageDescs };
}

async function extractText(fileName, fileBase64, mimeType) {
  const buffer = Buffer.from(fileBase64, 'base64');
  const ext = fileName.split('.').pop().toLowerCase();
  const hasGemini = !!process.env.GEMINI_API_KEY;

  let extractedText = '';
  let imageDescriptions = [];

  if (['txt', 'csv', 'json', 'md', 'log'].includes(ext)) {
    extractedText = buffer.toString('utf-8').slice(0, 15000);
  } else if (['docx', 'doc'].includes(ext)) {
    const r = await parseDocx(buffer, hasGemini);
    extractedText = r.extractedText;
    imageDescriptions = r.imageDescriptions;
  } else if (['xlsx', 'xls'].includes(ext)) {
    const r = await parseXlsx(buffer, hasGemini);
    extractedText = r.extractedText;
    imageDescriptions = r.imageDescriptions;
  } else if (ext === 'pdf') {
    if (hasGemini) {
      extractedText = await callGeminiVision(fileBase64, 'application/pdf', VISION_PROMPT_PDF);
    } else {
      extractedText = extractPdfTextRaw(buffer);
    }
  } else {
    extractedText = `[Loại .${ext} chưa hỗ trợ]`;
  }

  if (imageDescriptions.length > 0) {
    const imgSection = imageDescriptions
      .map((d, i) => `\n[Hình ${i + 1} trong file:\n${d}]`)
      .join('\n');
    extractedText += '\n\n--- HÌNH ẢNH TRÍCH XUẤT TỪ FILE ---' + imgSection;
  }

  return extractedText;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileName, fileBase64, mimeType, project = 'default', role = null } = req.body || {};
  if (!fileName || !fileBase64) {
    return res.status(400).json({ error: 'Thiếu fileName hoặc fileBase64' });
  }

  try {
    const rows = [];
    const ext = fileName.split('.').pop().toLowerCase();
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);

    if (isImage) {
      const description = await callGeminiVision(fileBase64, mimeType || `image/${ext}`, VISION_PROMPT_IMAGE);
      const imageUrl = await uploadImageToSupabase(fileBase64, fileName, 1, 0);
      const embedding = await createEmbedding(description);
      rows.push({
        file_name: fileName, project, role,
        page: 1, chunk_index: 0,
        chunk_type: 'image',
        chunk_text: description,
        image_url: imageUrl,
        embedding
      });
    } else {
      const extractedText = await extractText(fileName, fileBase64, mimeType);

      if (extractedText.trim()) {
        const chunks = chunkText(extractedText);
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await createEmbedding(chunks[i]);
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
    }

    if (rows.length > 0) {
      await saveChunks(rows);
    }

    return res.status(200).json({
      ok: true,
      fileName,
      chunks: rows.length,
      method: isImage ? 'vision' : 'text'
    });

  } catch (err) {
    console.error('[Ingest Error]', err);
    return res.status(500).json({ error: err.message });
  }
}

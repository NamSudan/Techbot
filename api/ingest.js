/**
 * TechBot — Ingest API
 * POST /api/ingest
 * Nhận { fileName, fileBase64, mimeType, project, role }
 * → Parse file (gọi /api/parse logic) → Chunk → Embed → Lưu Supabase
 */

import { createEmbedding, saveChunks, chunkText } from './embed.js';

const VISION_PROMPT_IMAGE = `Hãy phân tích hình ảnh kỹ thuật này và trích xuất TOÀN BỘ:
1. Tất cả văn bản, số liệu, kích thước có trong ảnh
2. Mô tả sơ đồ, bản vẽ, biểu đồ nếu có
3. Bảng biểu và dữ liệu trong bảng
4. Ký hiệu kỹ thuật, chú thích, ghi chú
Trả về text có cấu trúc rõ ràng.`;

async function callGeminiVision(base64Data, mimeType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
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
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function uploadImageToSupabase(base64Data, fileName, pageNum, imgIndex) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
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

    // Xử lý file ảnh → Vision AI mô tả + lưu storage
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
      // Gọi parse API để extract text (tái dùng logic parse.js)
      const vercelUrl = process.env.VERCEL_URL;
      const baseUrl = (vercelUrl && !vercelUrl.includes('localhost'))
        ? `https://${vercelUrl}`
        : 'http://localhost:3000';
      const parseRes = await fetch(`${baseUrl}/api/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, fileBase64, mimeType })
      });
      const parseData = await parseRes.json();
      const extractedText = parseData.extractedText || '';

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

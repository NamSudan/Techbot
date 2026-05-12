/**
 * TechBot — Ingest API  (Phase 1: Document Structure Awareness)
 * POST /api/ingest
 * Nhận { fileName, fileBase64, mimeType, project, role, userKeys }
 * → Extract text + images với position context → Chunk → Embed → Lưu Supabase
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

// ── Gemini Vision ─────────────────────────────────────────────────────────────

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
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
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

// ── Supabase Storage ──────────────────────────────────────────────────────────

async function uploadImageToSupabase(base64Data, fileName, sectionIndex, imgIndex) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return null;

  const path = `${fileName}/s${sectionIndex}_${imgIndex}.jpg`;
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/techbot-images/${path}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'true'
      },
      body: Buffer.from(base64Data, 'base64')
    }
  );

  if (!response.ok) return null;
  return `${supabaseUrl}/storage/v1/object/public/techbot-images/${path}`;
}

// ── File Deduplication ────────────────────────────────────────────────────────

async function deleteExistingChunks(fileName, project) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/documents?file_name=eq.${encodeURIComponent(fileName)}&project=eq.${encodeURIComponent(project)}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    }
  );
  if (!res.ok) console.warn('[Dedup] DELETE failed:', res.status);
}

// ── DOCX: Parse Relationships ─────────────────────────────────────────────────
// word/_rels/document.xml.rels → { rId5: 'word/media/image1.jpeg', ... }

function parseRels(relsXml) {
  const relMap = {};
  for (const m of relsXml.matchAll(/<Relationship([^>]+)>/g)) {
    const attrs = m[1];
    if (!attrs.includes('/image')) continue;
    const idM      = attrs.match(/Id="([^"]+)"/);
    const targetM  = attrs.match(/Target="([^"]+)"/);
    if (!idM || !targetM) continue;
    const target = targetM[1];
    // Normalise: Target may be "media/image1.jpeg" or "../media/image1.jpeg"
    relMap[idM[1]] = target.startsWith('word/') ? target : `word/${target.replace(/^\.\.\//, '')}`;
  }
  return relMap;
}

// ── DOCX: Parse Document Structure ───────────────────────────────────────────
// word/document.xml → ordered array of { type, text/rId, section, docPosition }

function parseDocStructure(docXml, relMap) {
  const items = [];
  let docPosition    = 0;
  let currentSection = '';
  let sectionIndex   = -1;

  for (const paraMatch of docXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const paraXml = paraMatch[0];

    // Detect heading style (explicit Word heading styles)
    const styleM    = paraXml.match(/<w:pStyle w:val="([^"]+)"/);
    const style     = styleM ? styleM[1] : '';
    const isWordHeading = /^[Hh]eading\d+$/i.test(style) || style === 'Title';

    // Detect list paragraph (numbered steps)
    const isList   = /ListParagraph|List/i.test(style);

    // Concatenate all text runs
    const text = [...paraXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
      .map(m => m[1]).join('').trim();

    // Heuristic heading: bold + ALL CAPS + short (for docs without Heading styles)
    // e.g. "TRƯỚC KHI VẬN HÀNH", "QUY TRÌNH NHÓM LÒ"
    const isBold = /<w:b\b/.test(paraXml) && !/<w:b w:val="0"/.test(paraXml);
    const isAllCaps = text.length > 3 && text.length < 100
      && text === text.toUpperCase()
      && /[\p{L}]/u.test(text)          // must have letters
      && !/^[\d\s\-–—.,:;]+$/.test(text); // not just numbers/punctuation
    const isPseudoHeading = isBold && isAllCaps;

    const isHeading = isWordHeading || isPseudoHeading;

    // Detect embedded image references (r:embed)
    const imgRefs = [...paraXml.matchAll(/r:embed="(rId[^"]+)"/g)].map(m => m[1]);

    if (isHeading && text) {
      currentSection = text;
      sectionIndex++;
      items.push({ type: 'heading', text, section: currentSection, sectionIndex, docPosition, isList });
    } else if (imgRefs.length > 0) {
      for (const rId of imgRefs) {
        const zipPath = relMap[rId];
        if (zipPath) {
          items.push({
            type: 'image',
            rId,
            zipPath,
            section: currentSection,
            sectionIndex,
            surroundingText: text || '',   // text in same paragraph as image
            docPosition,
            isList
          });
        }
      }
      // Paragraph has both image and text (caption-style)
      if (text) {
        items.push({ type: 'paragraph', text, section: currentSection, sectionIndex, docPosition, isList });
      }
    } else if (text) {
      items.push({ type: 'paragraph', text, section: currentSection, sectionIndex, docPosition, isList });
    }

    docPosition++;
  }

  return items;
}

// ── DOCX: Structured Parse (replaces old parseDocx) ──────────────────────────

async function parseDocxStructured(buffer, geminiKey, fileName) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);

  // 1. Relationships
  let relMap = {};
  if (zip.files['word/_rels/document.xml.rels']) {
    const relsXml = await zip.files['word/_rels/document.xml.rels'].async('string');
    relMap = parseRels(relsXml);
  }

  // 2. Document structure
  let structure = [];
  if (zip.files['word/document.xml']) {
    const docXml = await zip.files['word/document.xml'].async('string');
    structure = parseDocStructure(docXml, relMap);
  }

  // 3. Group by section
  const sections = new Map();   // sectionTitle → { index, items[] }
  let curSec = '__root__';
  let curSecIdx = -1;

  for (const item of structure) {
    if (item.type === 'heading') {
      curSec = item.text;
      curSecIdx = item.sectionIndex;
      if (!sections.has(curSec)) sections.set(curSec, { index: curSecIdx, items: [] });
    } else {
      if (!sections.has(curSec)) sections.set(curSec, { index: curSecIdx, items: [] });
      sections.get(curSec).items.push(item);
    }
  }

  // 4. Build text chunks (section-aware)
  const textChunks = [];
  for (const [sectionTitle, { index: secIdx, items }] of sections) {
    const paras = items.filter(i => i.type === 'paragraph');
    if (!paras.length) continue;

    const label    = (sectionTitle && sectionTitle !== '__root__') ? `[${sectionTitle}]\n` : '';
    const bodyText = paras.map(p => p.text).join('\n');
    const fullText = label + bodyText;

    // Split large sections into sub-chunks (preserve 600/100 config)
    const subChunks = chunkText(fullText);
    subChunks.forEach((chunk, ci) => {
      textChunks.push({
        sectionTitle: sectionTitle !== '__root__' ? sectionTitle : null,
        sectionIndex: secIdx,
        docPosition:  paras[0]?.docPosition ?? 0,
        chunkIndex:   ci,
        text:         chunk
      });
    });
  }

  // 5. Build image objects with surrounding context
  const imageObjects = [];
  let imgCounter = 0;

  for (const [sectionTitle, { index: secIdx, items }] of sections) {
    const paras   = items.filter(i => i.type === 'paragraph').sort((a, b) => a.docPosition - b.docPosition);
    const images  = items.filter(i => i.type === 'image');

    for (const imgItem of images) {
      if (imgCounter >= 20) break;   // hard cap

      // 2 paragraphs before + 2 after this image in same section
      const before = paras.filter(p => p.docPosition < imgItem.docPosition).slice(-2).map(p => p.text);
      const after  = paras.filter(p => p.docPosition > imgItem.docPosition).slice(0, 2).map(p => p.text);
      const surrounding = [...before, ...after].filter(Boolean).join(' ').trim()
        || imgItem.surroundingText;

      imageObjects.push({
        zipPath:        imgItem.zipPath,
        sectionTitle:   sectionTitle !== '__root__' ? sectionTitle : null,
        sectionIndex:   secIdx,
        docPosition:    imgItem.docPosition,
        surroundingText: surrounding,
        description:    null,
        imageUrl:       null,
        _counter:       imgCounter
      });
      imgCounter++;
    }
  }

  // 6. Process images with context-aware Gemini prompt
  if (geminiKey) {
    for (const img of imageObjects) {
      try {
        const imgFile = zip.files[img.zipPath];
        if (!imgFile) continue;

        const imgBuf  = await imgFile.async('nodebuffer');
        const imgB64  = imgBuf.toString('base64');
        const ext     = img.zipPath.split('.').pop().toLowerCase();
        const imgMime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

        // Inject context into prompt so Gemini understands the image's role
        const contextPrompt = img.surroundingText
          ? `Đây là hình ảnh trong tài liệu kỹ thuật thuộc mục "${img.sectionTitle || 'nội dung chính'}".
Văn bản xung quanh hình này: "${img.surroundingText}"

Dựa vào context đó, hãy mô tả chi tiết:
1. Nội dung chính của hình (thiết bị, bước thực hiện, số liệu, ký hiệu)
2. Ý nghĩa trong bối cảnh quy trình/tài liệu
3. Mọi thông số kỹ thuật đọc được (số đo, nhãn, trạng thái)
Trả về mô tả có cấu trúc rõ ràng.`
          : VISION_PROMPT_IMAGE;

        const [description, imageUrl] = await Promise.all([
          callGeminiVision(imgB64, imgMime, contextPrompt, geminiKey),
          uploadImageToSupabase(imgB64, fileName, img.sectionIndex ?? img._counter, img._counter)
        ]);

        img.description = description;
        img.imageUrl    = imageUrl;
      } catch (e) {
        console.warn(`[DOCX] Image ${img._counter + 1}:`, e.message);
        img.description = `[Không đọc được hình ${img._counter + 1}: ${e.message}]`;
      }
    }
  }

  return { textChunks, imageObjects };
}

// ── XLSX Parser ───────────────────────────────────────────────────────────────

async function parseXlsx(buffer, geminiKey, fileName) {
  const XLSX = await import('xlsx');
  let textContent = '';
  let imageObjects = [];

  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const lines = [];
    workbook.SheetNames.forEach(sheetName => {
      const ws  = workbook.Sheets[sheetName];
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

      for (let i = 0; i < Math.min(imgFiles.length, 20); i++) {
        const imgBuf  = await zip.files[imgFiles[i]].async('nodebuffer');
        const imgB64  = imgBuf.toString('base64');
        const ext     = imgFiles[i].split('.').pop().toLowerCase();
        const imgMime = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        try {
          const [desc, imageUrl] = await Promise.all([
            callGeminiVision(imgB64, imgMime, VISION_PROMPT_IMAGE, geminiKey),
            uploadImageToSupabase(imgB64, fileName, 1, i)
          ]);
          imageObjects.push({ description: desc, imageUrl, index: i, sectionTitle: null, sectionIndex: null, docPosition: i, surroundingText: null });
        } catch (e) {
          console.warn(`[XLSX] Hình ${i + 1}:`, e.message);
          imageObjects.push({ description: `[Không đọc được hình ${i + 1}: ${e.message}]`, imageUrl: null, index: i, sectionTitle: null, sectionIndex: null, docPosition: i, surroundingText: null });
        }
      }
    } catch (e) {
      console.warn('XLSX image extract error:', e.message);
    }
  }

  return { extractedText: textContent, imageObjects };
}

// ── PDF: raw text fallback ────────────────────────────────────────────────────

function extractPdfTextRaw(buffer) {
  try {
    const str  = buffer.toString('latin1');
    const texts = [];
    for (const m of str.matchAll(/BT\s*([\s\S]*?)\s*ET/g)) {
      for (const tj of m[1].matchAll(/\((.*?)\)\s*Tj/g)) {
        const t = tj[1]
          .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
          .replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
        if (t.trim()) texts.push(t);
      }
    }
    const result = texts.join(' ').slice(0, 8000);
    return result || '[PDF không có text layer — thêm GEMINI_API_KEY để đọc hình ảnh/scan]';
  } catch {
    return '[Không đọc được PDF]';
  }
}

// ── Model recommendation ──────────────────────────────────────────────────────

function recommendModel(ext, textChunks, imageChunks) {
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext))
    return { model: 'gemini', reason: 'File ảnh — cần Gemini Vision', required: true };
  if (ext === 'pdf') {
    if (textChunks === 0) return { model: 'gemini', reason: 'PDF scan/ảnh — không có text layer', required: true };
    return { model: 'gemini', reason: 'PDF có thể chứa sơ đồ/bảng', required: false };
  }
  if (['docx', 'doc', 'xlsx', 'xls'].includes(ext) && imageChunks > 3)
    return { model: 'gemini', reason: `Tài liệu có ${imageChunks} hình ảnh`, required: false };
  return { model: 'groq', reason: 'Tài liệu chủ yếu là text', required: false };
}

// ── Main Handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileName, fileBase64, mimeType, project = 'default', role = null, userKeys = {} } = req.body || {};
  if (!fileName || !fileBase64) return res.status(400).json({ error: 'Thiếu fileName hoặc fileBase64' });

  const geminiKey = userKeys.gemini || process.env.GEMINI_API_KEY;
  const ext       = fileName.split('.').pop().toLowerCase();
  const isImage   = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);

  try {
    // Deduplication: remove existing chunks for this file before re-ingesting
    await deleteExistingChunks(fileName, project);

    const rows   = [];
    const buffer = Buffer.from(fileBase64, 'base64');

    if (isImage) {
      // ── Direct image file ──
      const description = await callGeminiVision(fileBase64, mimeType || `image/${ext}`, VISION_PROMPT_IMAGE, geminiKey);
      const imageUrl    = await uploadImageToSupabase(fileBase64, fileName, 1, 0);
      const embedding   = await createEmbedding(description, geminiKey);
      rows.push({
        file_name: fileName, project, role,
        page: 1, chunk_index: 0,
        chunk_type: 'image',
        chunk_text: description,
        image_url: imageUrl,
        section_title: null, section_index: 0, doc_position: 0, surrounding_text: null,
        embedding
      });

    } else if (['docx', 'doc'].includes(ext)) {
      // ── DOCX: structured parse ──
      const { textChunks, imageObjects } = await parseDocxStructured(buffer, geminiKey, fileName);

      for (const tc of textChunks) {
        const embedding = await createEmbedding(tc.text, geminiKey);
        rows.push({
          file_name: fileName, project, role,
          page: null, chunk_index: tc.chunkIndex,
          chunk_type: 'text',
          chunk_text: tc.text,
          image_url: null,
          section_title:    tc.sectionTitle,
          section_index:    tc.sectionIndex,
          doc_position:     tc.docPosition,
          surrounding_text: null,
          embedding
        });
      }

      for (const img of imageObjects) {
        if (!img.description) continue;
        // Embed description + surrounding context for richer retrieval
        const embedText = img.surroundingText
          ? `${img.description}\nContext: ${img.surroundingText}`
          : img.description;
        const embedding = await createEmbedding(embedText, geminiKey);
        rows.push({
          file_name: fileName, project, role,
          page: null, chunk_index: img._counter,
          chunk_type: 'image',
          chunk_text: img.description,
          image_url: img.imageUrl,
          section_title:    img.sectionTitle,
          section_index:    img.sectionIndex,
          doc_position:     img.docPosition,
          surrounding_text: img.surroundingText,
          embedding
        });
      }

    } else if (['xlsx', 'xls'].includes(ext)) {
      // ── XLSX ──
      const { extractedText, imageObjects } = await parseXlsx(buffer, geminiKey, fileName);

      if (extractedText.trim()) {
        const chunks = chunkText(extractedText);
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await createEmbedding(chunks[i], geminiKey);
          rows.push({
            file_name: fileName, project, role,
            page: null, chunk_index: i,
            chunk_type: 'text', chunk_text: chunks[i], image_url: null,
            section_title: null, section_index: null, doc_position: i, surrounding_text: null,
            embedding
          });
        }
      }
      for (const img of imageObjects) {
        if (!img.description) continue;
        const embedding = await createEmbedding(img.description, geminiKey);
        rows.push({
          file_name: fileName, project, role,
          page: null, chunk_index: img.index,
          chunk_type: 'image', chunk_text: img.description, image_url: img.imageUrl,
          section_title: null, section_index: null, doc_position: img.docPosition, surrounding_text: null,
          embedding
        });
      }

    } else if (ext === 'pdf') {
      // ── PDF ──
      let extractedText;
      if (geminiKey) {
        extractedText = await callGeminiVision(fileBase64, 'application/pdf', VISION_PROMPT_PDF, geminiKey);
      } else {
        extractedText = extractPdfTextRaw(buffer);
      }
      if (extractedText.trim()) {
        const chunks = chunkText(extractedText);
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await createEmbedding(chunks[i], geminiKey);
          rows.push({
            file_name: fileName, project, role,
            page: null, chunk_index: i,
            chunk_type: 'text', chunk_text: chunks[i], image_url: null,
            section_title: null, section_index: null, doc_position: i, surrounding_text: null,
            embedding
          });
        }
      }

    } else if (['txt', 'csv', 'json', 'md', 'log'].includes(ext)) {
      // ── Plain text ──
      const extractedText = buffer.toString('utf-8');
      const chunks = chunkText(extractedText);
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await createEmbedding(chunks[i], geminiKey);
        rows.push({
          file_name: fileName, project, role,
          page: null, chunk_index: i,
          chunk_type: 'text', chunk_text: chunks[i], image_url: null,
          section_title: null, section_index: null, doc_position: i, surrounding_text: null,
          embedding
        });
      }

    } else {
      return res.status(200).json({ ok: false, fileName, chunks: 0, error: `Loại .${ext} chưa hỗ trợ` });
    }

    if (rows.length > 0) await saveChunks(rows);

    const imageChunks  = rows.filter(r => r.chunk_type === 'image').length;
    const textChunks   = rows.filter(r => r.chunk_type === 'text').length;
    const failedImages = rows.filter(r => r.chunk_type === 'image' && r.chunk_text?.includes('Không đọc được hình')).length;
    const recommendation = recommendModel(ext, textChunks, imageChunks);

    // Count unique sections for DOCX
    const sections = [...new Set(rows.map(r => r.section_title).filter(Boolean))];

    return res.status(200).json({
      ok: true,
      fileName,
      chunks: rows.length,
      textChunks,
      imageChunks,
      sections: sections.length,
      sectionTitles: sections,
      method: isImage ? 'vision' : 'structured',
      failedImages,
      recommendation
    });

  } catch (err) {
    console.error('[Ingest Error]', err);
    return res.status(500).json({ error: err.message });
  }
}

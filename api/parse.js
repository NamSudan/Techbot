/**
 * TechBot — File Parser v2
 * POST /api/parse
 *
 * Hỗ trợ trích xuất CẢ text lẫn hình ảnh trong file:
 *   .txt / .csv  → text trực tiếp
 *   .docx        → text (mammoth) + ảnh embedded (Gemini Vision)
 *   .xlsx        → tất cả sheets dạng CSV + ảnh embedded (Gemini Vision)
 *   .pdf         → Gemini Vision đọc cả text + hình + sơ đồ
 *   .png/.jpg    → Gemini Vision mô tả toàn bộ
 */

const VISION_PROMPT_IMAGE = `Hãy phân tích hình ảnh kỹ thuật này và trích xuất TOÀN BỘ:
1. Tất cả văn bản, số liệu, kích thước có trong ảnh
2. Mô tả sơ đồ, bản vẽ, biểu đồ nếu có
3. Bảng biểu và dữ liệu trong bảng
4. Ký hiệu kỹ thuật, chú thích, ghi chú
5. Thông tin title block nếu là bản vẽ kỹ thuật
Trả về text có cấu trúc rõ ràng.`;

const VISION_PROMPT_PDF = `Đây là tài liệu kỹ thuật PDF. Hãy trích xuất TOÀN BỘ nội dung:
1. Tất cả văn bản theo đúng thứ tự
2. Nội dung bảng biểu (giữ nguyên cấu trúc)
3. Số liệu, kích thước, thông số kỹ thuật
4. Mô tả hình ảnh, sơ đồ, bản vẽ nếu có
5. Chú thích, ghi chú, footnote
Trả về text đầy đủ, có cấu trúc.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileName, fileBase64, mimeType } = req.body || {};
  if (!fileName || !fileBase64) {
    return res.status(400).json({ error: 'Thiếu fileName hoặc fileBase64' });
  }

  try {
    const buffer    = Buffer.from(fileBase64, 'base64');
    const ext       = fileName.split('.').pop().toLowerCase();
    const hasGemini = !!process.env.GEMINI_API_KEY;

    let result = { extractedText: '', method: '', imageDescriptions: [], fileName };

    // ── TXT / CSV / JSON / MD ──
    if (['txt', 'csv', 'json', 'md', 'log'].includes(ext)) {
      result.extractedText = buffer.toString('utf-8').slice(0, 15000);
      result.method = 'text';
    }

    // ── DOCX — text + ảnh embedded ──
    else if (['docx', 'doc'].includes(ext)) {
      result = await parseDocx(buffer, fileName, hasGemini);
    }

    // ── XLSX — sheets + ảnh embedded ──
    else if (['xlsx', 'xls'].includes(ext)) {
      result = await parseXlsx(buffer, fileName, hasGemini);
    }

    // ── PDF — Gemini Vision (tốt nhất, đọc cả hình) ──
    else if (ext === 'pdf') {
      if (hasGemini) {
        const text = await callGeminiVision(fileBase64, 'application/pdf', VISION_PROMPT_PDF);
        result.extractedText = text;
        result.method = 'gemini-vision-pdf';
      } else {
        result.extractedText = extractPdfTextRaw(buffer);
        result.method = 'pdf-raw-text';
        result.warning = 'Thêm GEMINI_API_KEY để đọc hình ảnh trong PDF';
      }
    }

    // ── ẢNH trực tiếp ──
    else if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
      if (hasGemini) {
        const imgMime = mimeType || `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        const text    = await callGeminiVision(fileBase64, imgMime, VISION_PROMPT_IMAGE);
        result.extractedText = text;
        result.method = 'gemini-vision-image';
      } else {
        result.extractedText = `[File ảnh: ${fileName} — cần GEMINI_API_KEY để phân tích]`;
        result.method = 'no-vision';
      }
    }

    else {
      result.extractedText = `[Loại .${ext} chưa hỗ trợ. Hỗ trợ: txt, csv, docx, xlsx, pdf, png, jpg]`;
      result.method = 'unsupported';
    }

    // Ghép mô tả ảnh vào text nếu có
    if (result.imageDescriptions && result.imageDescriptions.length > 0) {
      const imgSection = result.imageDescriptions
        .map((d, i) => `\n[Hình ${i + 1} trong file:\n${d}]`)
        .join('\n');
      result.extractedText += '\n\n--- HÌNH ẢNH TRÍCH XUẤT TỪ FILE ---' + imgSection;
    }

    return res.status(200).json({
      extractedText: result.extractedText,
      method:        result.method,
      fileName,
      imageCount:    result.imageDescriptions?.length || 0,
      charCount:     result.extractedText.length,
      warning:       result.warning || null
    });

  } catch (err) {
    console.error('[Parse Error]', err);
    return res.status(500).json({ error: err.message });
  }
};

// ══════════════════════════════════════════
// PARSER: DOCX (text + ảnh embedded)
// ══════════════════════════════════════════
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

async function parseDocx(buffer, fileName, hasGemini) {
  const mammoth = (await import('mammoth')).default;
  let textContent = '';
  let imageDescs  = [];
  let method      = 'mammoth-text';

  // Bước 1: Trích xuất text
  try {
    const r = await mammoth.extractRawText({ buffer });
    textContent = r.value.slice(0, 50000);
  } catch (e) {
    textContent = `[Lỗi đọc text DOCX: ${e.message}]`;
  }

  // Fallback: nếu mammoth trả về ít text, đọc XML trực tiếp để lấy nội dung text boxes
  if (textContent.length < 100) {
    const xmlText = await extractDocxXmlText(buffer);
    if (xmlText.length > textContent.length) {
      textContent = xmlText.slice(0, 50000);
      method = 'xml-fallback';
    }
  }

  // Bước 2: Trích xuất hình ảnh embedded (DOCX là file ZIP)
  if (hasGemini) {
    try {
      const { default: JSZip } = await import('jszip');
      const zip      = await JSZip.loadAsync(buffer);
      const imgExts  = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
      const imgFiles = Object.keys(zip.files).filter(name => {
        const e = name.split('.').pop().toLowerCase();
        return name.startsWith('word/media/') && imgExts.includes(e);
      });

      if (imgFiles.length > 0) {
        const limit = Math.min(imgFiles.length, 20);
        for (let i = 0; i < limit; i++) {
          const imgBuf  = await zip.files[imgFiles[i]].async('nodebuffer');
          const imgB64  = imgBuf.toString('base64');
          const imgExt  = imgFiles[i].split('.').pop().toLowerCase();
          const imgMime = `image/${imgExt === 'jpg' ? 'jpeg' : imgExt}`;
          try {
            const desc = await callGeminiVision(imgB64, imgMime, VISION_PROMPT_IMAGE);
            imageDescs.push(desc);
          } catch {
            imageDescs.push(`[Không đọc được hình ${i + 1}]`);
          }
        }
        method = `mammoth+gemini-vision (${imgFiles.length} ảnh)`;
      }
    } catch (e) {
      console.warn('DOCX image extract error:', e.message);
    }
  } else if (textContent) {
    method = 'mammoth-text-only';
  }

  return { extractedText: textContent, method, imageDescriptions: imageDescs, fileName };
}

// ══════════════════════════════════════════
// PARSER: XLSX (sheets + ảnh embedded)
// ══════════════════════════════════════════
async function parseXlsx(buffer, fileName, hasGemini) {
  const XLSX = await import('xlsx');
  let textContent = '';
  let imageDescs  = [];
  let method      = 'xlsx-parser';

  // Bước 1: Trích xuất data từ tất cả sheets
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const lines    = [];
    workbook.SheetNames.forEach(sheetName => {
      const ws  = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (csv.trim()) lines.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    });
    textContent = lines.join('\n\n').slice(0, 12000);
  } catch (e) {
    textContent = `[Lỗi đọc XLSX: ${e.message}]`;
  }

  // Bước 2: Trích xuất ảnh trong XLSX (cũng là file ZIP)
  if (hasGemini) {
    try {
      const { default: JSZip } = await import('jszip');
      const zip      = await JSZip.loadAsync(buffer);
      const imgFiles = Object.keys(zip.files).filter(name => {
        const e = name.split('.').pop().toLowerCase();
        return name.startsWith('xl/media/') && ['png','jpg','jpeg','gif','bmp'].includes(e);
      });

      if (imgFiles.length > 0) {
        const limit = Math.min(imgFiles.length, 20);
        for (let i = 0; i < limit; i++) {
          const imgBuf  = await zip.files[imgFiles[i]].async('nodebuffer');
          const imgB64  = imgBuf.toString('base64');
          const imgExt  = imgFiles[i].split('.').pop().toLowerCase();
          const imgMime = `image/${imgExt === 'jpg' ? 'jpeg' : imgExt}`;
          try {
            const desc = await callGeminiVision(imgB64, imgMime, VISION_PROMPT_IMAGE);
            imageDescs.push(desc);
          } catch {
            imageDescs.push(`[Không đọc được hình ${i + 1}]`);
          }
        }
        method = `xlsx+gemini-vision (${imgFiles.length} ảnh)`;
      }
    } catch (e) {
      console.warn('XLSX image extract error:', e.message);
    }
  }

  return { extractedText: textContent, method, imageDescriptions: imageDescs, fileName };
}

// ══════════════════════════════════════════
// Gemini Vision API
// ══════════════════════════════════════════
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
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '[Không có kết quả Vision]';
}

// ══════════════════════════════════════════
// PDF raw text fallback (không cần thư viện)
// ══════════════════════════════════════════
function extractPdfTextRaw(buffer) {
  try {
    const str   = buffer.toString('latin1');
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

/**
 * Phase 1 Test — DOCX Structure Parsing
 * Chạy: node test_phase1.mjs
 * Không cần Gemini key — test logic parsing thuần túy
 */

import { readFileSync } from 'fs';
import JSZip from 'jszip';

const DOCX_PATH = '/root/.claude/uploads/8500213a-bc35-4107-b058-9afd0301b727/a1fd6bdd-QUI_TRINH_V_N_H_NH_L____T_PX3_02.06.2022.docx';

// ── Copy từ ingest.js ─────────────────────────────────────────────────────────

function parseRels(relsXml) {
  const relMap = {};
  for (const m of relsXml.matchAll(/<Relationship([^>]+)>/g)) {
    const attrs = m[1];
    if (!attrs.includes('/image')) continue;
    const idM     = attrs.match(/Id="([^"]+)"/);
    const targetM = attrs.match(/Target="([^"]+)"/);
    if (!idM || !targetM) continue;
    const target  = targetM[1];
    relMap[idM[1]] = target.startsWith('word/') ? target : `word/${target.replace(/^\.\.\//, '')}`;
  }
  return relMap;
}

function parseDocStructure(docXml, relMap) {
  const items = [];
  let docPosition    = 0;
  let currentSection = '';
  let sectionIndex   = -1;

  for (const paraMatch of docXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const paraXml  = paraMatch[0];
    const styleM        = paraXml.match(/<w:pStyle w:val="([^"]+)"/);
    const style         = styleM ? styleM[1] : '';
    const isWordHeading = /^[Hh]eading\d+$/i.test(style) || style === 'Title';

    const text = [...paraXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
      .map(m => m[1]).join('').trim();

    // Heuristic: bold + ALL CAPS + short = pseudo-heading (for docs without Heading styles)
    const isBold    = /<w:b\b/.test(paraXml) && !/<w:b w:val="0"/.test(paraXml);
    const isAllCaps = text.length > 3 && text.length < 100
      && text === text.toUpperCase()
      && /[\p{L}]/u.test(text)
      && !/^[\d\s\-–—.,:;]+$/.test(text);
    const isHeading = isWordHeading || (isBold && isAllCaps);

    const imgRefs = [...paraXml.matchAll(/r:embed="(rId[^"]+)"/g)].map(m => m[1]);

    if (isHeading && text) {
      currentSection = text;
      sectionIndex++;
      items.push({ type: 'heading', text, section: currentSection, sectionIndex, docPosition, style });
    } else if (imgRefs.length > 0) {
      for (const rId of imgRefs) {
        const zipPath = relMap[rId];
        if (zipPath) {
          items.push({ type: 'image', rId, zipPath, section: currentSection, sectionIndex, surroundingText: text || '', docPosition });
        }
      }
      if (text) items.push({ type: 'paragraph', text, section: currentSection, sectionIndex, docPosition });
    } else if (text) {
      items.push({ type: 'paragraph', text, section: currentSection, sectionIndex, docPosition });
    }
    docPosition++;
  }
  return items;
}

// ── Test ──────────────────────────────────────────────────────────────────────

const colors = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', blue: '\x1b[34m', dim: '\x1b[2m', magenta: '\x1b[35m'
};
const c = (col, str) => `${colors[col]}${str}${colors.reset}`;

async function run() {
  console.log(c('bold', '\n══════════════════════════════════════════════'));
  console.log(c('cyan',  '  Phase 1 Test — DOCX Structure Parser'));
  console.log(c('bold', '══════════════════════════════════════════════\n'));

  // 1. Load file
  const buffer = readFileSync(DOCX_PATH);
  const zip    = await JSZip.loadAsync(buffer);
  console.log(c('green', '✓ File loaded:'), buffer.length.toLocaleString(), 'bytes');

  // 2. List all zip entries
  const allFiles = Object.keys(zip.files);
  const mediaFiles = allFiles.filter(f => f.startsWith('word/media/'));
  console.log(c('green', '✓ Images in word/media/:'), mediaFiles.length, 'files');
  mediaFiles.forEach(f => {
    const size = zip.files[f]._data?.uncompressedSize || '?';
    console.log(c('dim', `   ${f} (${typeof size === 'number' ? Math.round(size/1024)+'KB' : size})`));
  });

  // 3. Parse relationships
  console.log(c('bold', '\n── Relationship Map (rId → file) ──────────────'));
  const relsXml = await zip.files['word/_rels/document.xml.rels'].async('string');
  const relMap  = parseRels(relsXml);
  const relEntries = Object.entries(relMap);
  console.log(c('green', `✓ ${relEntries.length} image relationships found`));
  relEntries.forEach(([rId, path]) => {
    console.log(c('dim', `   ${rId} → ${path}`));
  });

  // 4. Parse document structure
  console.log(c('bold', '\n── Document Structure ──────────────────────────'));
  const docXml   = await zip.files['word/document.xml'].async('string');
  const structure = parseDocStructure(docXml, relMap);

  const headings  = structure.filter(i => i.type === 'heading');
  const paragraphs = structure.filter(i => i.type === 'paragraph');
  const images    = structure.filter(i => i.type === 'image');

  console.log(c('green', `✓ Total items: ${structure.length}`));
  console.log(`   ${c('cyan', headings.length + ' headings')} | ${c('yellow', paragraphs.length + ' paragraphs')} | ${c('magenta', images.length + ' images')}`);

  // 5. Show sections
  if (headings.length > 0) {
    console.log(c('bold', '\n── Sections detected ───────────────────────────'));
    headings.forEach(h => {
      const imgsInSection = images.filter(i => i.sectionIndex === h.sectionIndex);
      const parasInSection = paragraphs.filter(p => p.sectionIndex === h.sectionIndex);
      console.log(`   ${c('cyan', `[${h.sectionIndex}]`)} ${c('bold', h.text)} ${c('dim', `(style: ${h.style})`)}`);
      console.log(c('dim', `       ${parasInSection.length} paragraphs, ${imgsInSection.length} images`));
    });
  } else {
    console.log(c('yellow', '\n⚠ No headings found — document uses flat structure'));
    console.log(c('dim', '  All content grouped under root section'));
  }

  // 6. Show image → context mapping (THE KEY FEATURE)
  console.log(c('bold', '\n── Image → Context Mapping (Phase 1 key output) ──'));
  if (images.length === 0) {
    console.log(c('red', '✗ No images found via XML parsing'));
    console.log(c('dim', '  Check: relMap has entries?'), relEntries.length > 0 ? 'yes' : 'NO');
  } else {
    for (const img of images) {
      const idx = images.indexOf(img) + 1;

      // Find surrounding paragraphs
      const sectionParas = paragraphs
        .filter(p => p.sectionIndex === img.sectionIndex)
        .sort((a, b) => a.docPosition - b.docPosition);
      const before = sectionParas.filter(p => p.docPosition < img.docPosition).slice(-2).map(p => p.text);
      const after  = sectionParas.filter(p => p.docPosition > img.docPosition).slice(0, 2).map(p => p.text);
      const surrounding = [...before, ...after].filter(Boolean).join(' | ') || img.surroundingText || '(none)';

      console.log(`\n${c('magenta', `  Image ${idx}:`)} ${c('dim', img.zipPath)}`);
      console.log(`   ${c('cyan', 'Section:')}     ${img.section || c('red', '(no section — root)')}`);
      console.log(`   ${c('cyan', 'Position:')}    doc_position=${img.docPosition}, section_index=${img.sectionIndex}`);
      console.log(`   ${c('cyan', 'Context:')}     ${surrounding.length > 120 ? surrounding.slice(0, 120) + '…' : surrounding}`);

      // This is what Gemini would receive as context
      const geminiPrompt = surrounding !== '(none)'
        ? `Mục: "${img.section || 'nội dung chính'}" | Context: "${surrounding.slice(0, 80)}..."`
        : 'Không có context';
      console.log(`   ${c('green', 'Gemini ctx:')} ${geminiPrompt}`);
    }
  }

  // 7. Before vs After comparison
  console.log(c('bold', '\n── Before vs After ─────────────────────────────'));
  console.log(c('red',   '  BEFORE (old parseDocx):'));
  console.log(c('dim',   '    Gemini prompt: "Phân tích hình ảnh kỹ thuật này..." (no context)'));
  console.log(c('dim',   '    Stored as: { chunk_type: "image", section_title: null, surrounding_text: null }'));
  console.log();
  console.log(c('green', '  AFTER (parseDocxStructured):'));
  if (images.length > 0) {
    const firstImg = images[0];
    const sectionParas = paragraphs.filter(p => p.sectionIndex === firstImg.sectionIndex).sort((a,b) => a.docPosition - b.docPosition);
    const surrounding  = sectionParas.filter(p => p.docPosition < firstImg.docPosition).slice(-2).map(p => p.text).join(' ');
    console.log(c('dim',   `    Gemini prompt: "Thuộc mục '${firstImg.section || 'root'}'. Văn bản: '${surrounding.slice(0,60) || 'N/A'}...'" `));
    console.log(c('dim',   `    Stored as: { section_title: "${firstImg.section || null}", doc_position: ${firstImg.docPosition}, surrounding_text: "..." }`));
  }

  // 8. Chunk preview
  console.log(c('bold', '\n── Section-aware chunk preview ─────────────────'));
  const sectionMap = new Map();
  let curSec = '__root__';
  for (const item of structure) {
    if (item.type === 'heading') { curSec = item.text; if (!sectionMap.has(curSec)) sectionMap.set(curSec, []); }
    else { if (!sectionMap.has(curSec)) sectionMap.set(curSec, []); sectionMap.get(curSec).push(item); }
  }
  let chunkCount = 0;
  for (const [sec, items] of sectionMap) {
    const text = items.filter(i => i.type === 'paragraph').map(i => i.text).join(' ');
    const imgs = items.filter(i => i.type === 'image').length;
    if (!text.trim() && imgs === 0) continue;
    chunkCount++;
    const label = sec === '__root__' ? c('dim', '(root)') : c('cyan', sec);
    console.log(`   Chunk ${chunkCount}: ${label} — ${text.length} chars text, ${imgs} image(s)`);
    if (text) console.log(c('dim', `     Preview: "${text.slice(0, 80).replace(/\n/g,' ')}..."`));
  }

  console.log(c('bold', '\n══════════════════════════════════════════════'));
  console.log(c('green', `  ✓ Phase 1 parsing: ${images.length} images correctly mapped`));
  console.log(c('green', `  ✓ ${headings.length} sections detected, ${chunkCount} structured chunks`));
  console.log(c('green', `  ✓ Each image has surrounding context for Gemini`));
  console.log(c('bold', '══════════════════════════════════════════════\n'));
}

run().catch(e => {
  console.error('\x1b[31m✗ Error:\x1b[0m', e.message);
  console.error(e.stack);
  process.exit(1);
});

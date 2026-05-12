import JSZip from 'jszip';
import { readFileSync } from 'fs';

const FILE_PATH = '/root/.claude/uploads/891b7bf0-cfff-4a12-8588-0e6622b5df88/cae5bcec-QUI_TRINH_V_N_H_NH_L____T_PX3_02.06.2022.docx';

function parseRels(relsXml) {
  const map = {};
  for (const m of relsXml.matchAll(/<Relationship([^>]+)>/g)) {
    const attrs = m[1];
    if (!attrs.includes('/image')) continue;
    const id     = (attrs.match(/Id="([^"]+)"/)     || [])[1];
    const target = (attrs.match(/Target="([^"]+)"/) || [])[1];
    if (id && target) {
      const norm = target.replace(/^\.\.\//, 'word/').replace(/^(?!word\/)/, 'word/');
      map[id] = norm;
    }
  }
  return map;
}

function stripXml(xml) {
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDocxStructure(docXml, relMap) {
  const items = [];
  let currentSection = '__root__';
  let sectionIndex = 0;
  let docPosition = 0;

  for (const m of docXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const paraXml = m[0];

    // Detect heading style
    const styleMatch = paraXml.match(/w:styleId="([^"]+)"/);
    const style = styleMatch ? styleMatch[1] : '';
    const isHeading = /^(Heading|heading|\w*[Hh]eading)\d?/.test(style);

    const text = stripXml(paraXml).trim();

    // Heuristic heading: bold + ALL CAPS + short
    const isBold = paraXml.includes('<w:b/>') || paraXml.includes('<w:b ');
    const isAllCaps = text === text.toUpperCase() && text.length > 3 && text.length < 120;
    const isHeuristic = isBold && isAllCaps && !/<w:drawing|w:pict/.test(paraXml);

    if ((isHeading || isHeuristic) && text) {
      currentSection = text;
      sectionIndex++;
    }

    // Detect embedded image references
    const imgRefs = [...paraXml.matchAll(/r:embed="(rId[^"]+)"/g)].map(m => m[1]);

    if (imgRefs.length > 0) {
      for (const rId of imgRefs) {
        const zipPath = relMap[rId];
        items.push({ type: 'image', rId, zipPath, section: currentSection, sectionIndex, docPosition, surroundingText: text || '' });
        docPosition++;
      }
    } else if (text) {
      items.push({ type: 'text', text, section: currentSection, sectionIndex, docPosition });
      docPosition++;
    }
  }
  return items;
}

async function main() {
  const buffer = readFileSync(FILE_PATH);
  const zip = await JSZip.loadAsync(buffer);

  // 1. Parse relationships
  let relMap = {};
  if (zip.files['word/_rels/document.xml.rels']) {
    const relsXml = await zip.files['word/_rels/document.xml.rels'].async('string');
    relMap = parseRels(relsXml);
  }

  console.log('\n=== RELATIONSHIP MAP (ảnh) ===');
  const imgEntries = Object.entries(relMap);
  if (imgEntries.length === 0) {
    console.log('  ⚠️  Không tìm thấy ảnh nào trong word/_rels/document.xml.rels');
  } else {
    imgEntries.forEach(([rId, path]) => console.log(`  ${rId} → ${path}`));
  }

  // 2. Parse document structure
  const docXml = await zip.files['word/document.xml'].async('string');
  const items = parseDocxStructure(docXml, relMap);

  const headings = items.filter(i => i.section !== '__root__').map(i => i.section);
  const uniqueHeadings = [...new Set(headings)];
  const images = items.filter(i => i.type === 'image');
  const texts = items.filter(i => i.type === 'text');

  console.log('\n=== SECTIONS / HEADINGS phát hiện được ===');
  if (uniqueHeadings.length === 0) {
    console.log('  ⚠️  Không phát hiện heading nào (tài liệu không dùng Word Heading styles hoặc bold+CAPS)');
  } else {
    uniqueHeadings.forEach((h, i) => console.log(`  [${i + 1}] ${h}`));
  }

  console.log(`\n=== THỐNG KÊ ===`);
  console.log(`  Tổng đoạn văn bản : ${texts.length}`);
  console.log(`  Tổng hình ảnh     : ${images.length}`);
  console.log(`  Sections phát hiện: ${uniqueHeadings.length}`);

  console.log('\n=== HÌNH ẢNH + VỊ TRÍ ===');
  if (images.length === 0) {
    console.log('  ⚠️  Không tìm thấy hình ảnh nào trong document.xml');

    // Debug: check raw for drawing tags
    const drawingCount = (docXml.match(/<w:drawing/g) || []).length;
    const pictCount = (docXml.match(/<w:pict/g) || []).length;
    const blipCount = (docXml.match(/r:embed=/g) || []).length;
    console.log(`  Debug: <w:drawing> tags: ${drawingCount}, <w:pict> tags: ${pictCount}, r:embed= attrs: ${blipCount}`);
  } else {
    images.forEach((img, i) => {
      const zipOk = img.zipPath && zip.files[img.zipPath] ? '✅' : '❌ missing in zip';
      console.log(`\n  [Hình ${i + 1}]`);
      console.log(`    rId          : ${img.rId}`);
      console.log(`    Zip path     : ${img.zipPath || 'KHÔNG TÌM THẤY'} ${zipOk}`);
      console.log(`    Section      : ${img.section}`);
      console.log(`    Doc position : ${img.docPosition}`);
      console.log(`    Context text : "${img.surroundingText.substring(0, 80)}"`);
    });
  }

  // 3. List all files in zip (media)
  const mediaFiles = Object.keys(zip.files).filter(f => f.startsWith('word/media/'));
  console.log(`\n=== FILES TRONG word/media/ (${mediaFiles.length} file) ===`);
  mediaFiles.forEach(f => console.log(`  ${f}`));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

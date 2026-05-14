import { createEmbedding, searchDocuments, fetchSectionChunks } from './embed.js';

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Tính toán biểu thức toán học. Hỗ trợ: +, -, *, /, **, Math.sqrt, Math.PI, Math.sin, Math.cos, Math.log, Math.abs, Math.round, Math.ceil, Math.floor. Dùng khi người dùng yêu cầu tính toán số liệu kỹ thuật.',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: 'Biểu thức toán học hợp lệ JavaScript, ví dụ: "3.14 * (50/2)**2 * 100" hoặc "Math.sqrt(9.81 * 2 * 15)"'
          }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'convert_unit',
      description: 'Chuyển đổi đơn vị kỹ thuật. Hỗ trợ: áp suất (PSI, MPa, bar, kPa, atm), chiều dài (m, cm, mm, inch, ft), khối lượng (kg, g, lb, ton), nhiệt độ (C, F, K), công suất (kW, hp, W), lực (N, kN, kgf, lbf), thể tích (L, m3, gallon).',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number', description: 'Giá trị cần chuyển đổi' },
          from_unit: { type: 'string', description: 'Đơn vị nguồn (ví dụ: PSI, MPa, bar, C, F, kg, lb)' },
          to_unit: { type: 'string', description: 'Đơn vị đích' }
        },
        required: ['value', 'from_unit', 'to_unit']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_technical_standard',
      description: 'Tìm kiếm thông tin về tiêu chuẩn kỹ thuật, quy chuẩn (TCVN, ASTM, ISO, API, ASME, IEC, IEEE). Dùng khi người dùng hỏi về tiêu chuẩn mà tài liệu không có.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Tên tiêu chuẩn hoặc câu hỏi về tiêu chuẩn kỹ thuật' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rag_search',
      description: 'Tìm kiếm thêm trong tài liệu đã upload với query cụ thể hơn. Dùng khi câu trả lời ban đầu cần thêm thông tin chi tiết từ tài liệu, hoặc khi cần tìm một khía cạnh cụ thể khác của vấn đề.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Câu hỏi tìm kiếm cụ thể trong tài liệu' },
          intent: {
            type: 'string',
            enum: ['overview', 'detail'],
            description: '"detail" để lấy nội dung chi tiết (5 chunks), "overview" để lấy tổng quan rộng (20 chunks)'
          }
        },
        required: ['query', 'intent']
      }
    }
  }
];

// Unit conversion tables (all to SI base, then to target)
const PRESSURE_TO_PA = { psi: 6894.76, mpa: 1e6, bar: 1e5, kpa: 1e3, pa: 1, atm: 101325 };
const LENGTH_TO_M = { m: 1, cm: 0.01, mm: 0.001, inch: 0.0254, in: 0.0254, ft: 0.3048, km: 1000 };
const MASS_TO_KG = { kg: 1, g: 0.001, lb: 0.453592, lbs: 0.453592, ton: 1000, tonne: 1000 };
const POWER_TO_W = { w: 1, kw: 1000, mw: 1e6, hp: 745.7 };
const FORCE_TO_N = { n: 1, kn: 1000, kgf: 9.80665, lbf: 4.44822 };
const VOLUME_TO_L = { l: 1, ml: 0.001, m3: 1000, cm3: 0.001, gallon: 3.78541, gal: 3.78541, ft3: 28.3168 };

function convertUnit(value, from, to) {
  const f = from.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = to.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Temperature (special case — not multiplicative)
  const temps = new Set(['c', 'f', 'k', 'celsius', 'fahrenheit', 'kelvin']);
  if (temps.has(f) || temps.has(t)) {
    const toCelsius = { c: v => v, celsius: v => v, f: v => (v - 32) * 5/9, fahrenheit: v => (v - 32) * 5/9, k: v => v - 273.15, kelvin: v => v - 273.15 };
    const fromCelsius = { c: v => v, celsius: v => v, f: v => v * 9/5 + 32, fahrenheit: v => v * 9/5 + 32, k: v => v + 273.15, kelvin: v => v + 273.15 };
    if (!toCelsius[f] || !fromCelsius[t]) throw new Error(`Không hỗ trợ chuyển đổi nhiệt độ: ${from} → ${to}`);
    return fromCelsius[t](toCelsius[f](value));
  }

  const tables = [PRESSURE_TO_PA, LENGTH_TO_M, MASS_TO_KG, POWER_TO_W, FORCE_TO_N, VOLUME_TO_L];
  for (const table of tables) {
    if (table[f] !== undefined && table[t] !== undefined) {
      return value * table[f] / table[t];
    }
  }
  throw new Error(`Không hỗ trợ chuyển đổi: ${from} → ${to}`);
}

// Safe math evaluator — only allows numeric literals and safe Math.* calls
const SAFE_EXPR = /^[0-9\s\+\-\*\/\.\(\)\^%,]+$|^[\w\s\+\-\*\/\.\(\)\^%,]+$/;
const ALLOWED_GLOBALS = 'Math.sqrt,Math.PI,Math.sin,Math.cos,Math.tan,Math.log,Math.log10,Math.abs,Math.round,Math.ceil,Math.floor,Math.min,Math.max,Math.pow,Math.exp';

function safeCalculate(expression) {
  // Block dangerous patterns
  if (/import|require|process|global|window|document|eval|Function|fetch|__/i.test(expression)) {
    throw new Error('Biểu thức không được phép');
  }
  const allowed = new Set(ALLOWED_GLOBALS.split(','));
  const fnNames = expression.match(/[a-zA-Z_$][\w$.]*/g) || [];
  for (const fn of fnNames) {
    if (!allowed.has(fn) && !/^Math\.\w+$/.test(fn)) {
      throw new Error(`Hàm không được phép: ${fn}`);
    }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; return (${expression})`)();
}

export async function executeTool(toolName, args, context = {}) {
  switch (toolName) {
    case 'calculate': {
      const result = safeCalculate(args.expression);
      if (typeof result !== 'number' || !isFinite(result)) throw new Error('Kết quả không hợp lệ');
      const formatted = Number.isInteger(result) ? result.toString() : result.toPrecision(6).replace(/\.?0+$/, '');
      return `Kết quả: ${args.expression} = **${formatted}**`;
    }

    case 'convert_unit': {
      const result = convertUnit(args.value, args.from_unit, args.to_unit);
      const formatted = Number.isInteger(result) ? result.toString() : result.toPrecision(6).replace(/\.?0+$/, '');
      return `${args.value} ${args.from_unit} = **${formatted} ${args.to_unit}**`;
    }

    case 'search_technical_standard': {
      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return `Không tìm được thông tin về: ${args.query}`;
        const data = await res.json();
        const abstract = data.AbstractText || data.Answer || '';
        const source = data.AbstractURL || '';
        if (!abstract) return `Không tìm thấy thông tin nhanh về "${args.query}". Vui lòng tham khảo trực tiếp tài liệu tiêu chuẩn.`;
        return `**${args.query}**: ${abstract}${source ? ` (Nguồn: ${source})` : ''}`;
      } catch {
        return `Không thể tra cứu tiêu chuẩn "${args.query}" lúc này. Vui lòng kiểm tra tài liệu trực tiếp.`;
      }
    }

    case 'rag_search': {
      const { project, geminiKey } = context;
      if (!project || !geminiKey) return 'Không có tài liệu nào được chọn để tìm kiếm.';
      const embedding = await createEmbedding(args.query, geminiKey);
      const intent = args.intent || 'detail';
      let chunks = await searchDocuments(embedding, project, intent);
      if (intent === 'detail' && chunks.length > 0) {
        chunks = await fetchSectionChunks(chunks, project);
      }
      if (chunks.length === 0) return `Không tìm thấy thông tin liên quan đến: "${args.query}"`;
      const snippets = chunks.slice(0, 5).map((c, i) =>
        `[${i + 1}] ${c.section_title ? `**${c.section_title}**: ` : ''}${c.chunk_text.slice(0, 300)}...`
      );
      return snippets.join('\n\n');
    }

    default:
      throw new Error(`Tool không tồn tại: ${toolName}`);
  }
}

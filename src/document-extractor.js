import path from 'node:path';

export const DOCUMENT_MAX_BYTES = 6 * 1024 * 1024;
export const DOCUMENT_MAX_CHARS = 120_000;

const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.xml', '.yaml', '.yml']);
const supportedExtensions = new Set([...textExtensions, '.pdf', '.docx']);

export function documentKind(filename = '') {
  const extension = path.extname(filename).toLowerCase();
  return supportedExtensions.has(extension) ? extension : null;
}

function cleanExtractedText(value) {
  const normalized = String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  const truncated = normalized.length > DOCUMENT_MAX_CHARS;
  return {
    text: truncated ? normalized.slice(0, DOCUMENT_MAX_CHARS) : normalized,
    truncated
  };
}

async function extractPdf(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str || '').join(' ');
      pages.push(`--- Página ${pageNumber} ---\n${text}`);
      if (pages.join('\n\n').length > DOCUMENT_MAX_CHARS) break;
    }
  } finally {
    await document.destroy();
  }
  return pages.join('\n\n');
}

async function extractDocx(buffer) {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function extractDocument({ buffer, filename }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('El documento está vacío.');
  if (buffer.length > DOCUMENT_MAX_BYTES) throw new Error('El documento supera el límite de 6 MB.');
  const kind = documentKind(filename);
  if (!kind) throw new Error('Formato no admitido. Usa PDF, DOCX, TXT, MD, CSV o JSON.');

  let rawText = '';
  if (textExtensions.has(kind)) rawText = new TextDecoder('utf-8').decode(buffer);
  else if (kind === '.pdf') rawText = await extractPdf(buffer);
  else if (kind === '.docx') rawText = await extractDocx(buffer);

  const result = cleanExtractedText(rawText);
  if (!result.text) throw new Error('No se ha podido extraer texto del documento.');
  return { ...result, kind: kind.slice(1) };
}

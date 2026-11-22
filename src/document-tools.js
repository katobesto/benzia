// Herramientas de lectura de documentos para el chat.
//
// El objetivo es dar al modelo acceso bajo demanda al contenido de un archivo
// sin dos riesgos: ejecutar nada del archivo (no hay shell, no hay fórmulas) y
// volcar 120.000 caracteres en cada petición. El documento se guarda en memoria
// al extraerlo y el modelo lo consulta por secciones, con límites duros.
//
// Todo lo que devuelve esta capa es texto ya sanitizado de caracteres de
// control; nunca rutas del servidor, ni contenido de otros usuarios.

import crypto from 'node:crypto';

import { DOCUMENT_MAX_CHARS } from './document-extractor.js';

export const DOCUMENT_TOOL_TTL_MS = 6 * 60 * 60 * 1000;
export const DOCUMENT_TOOL_MAX_DOCS = 64;
export const DOCUMENT_TOOL_MAX_RESULT_CHARS = 14_000;
export const DOCUMENT_TOOL_MAX_ROWS = 120;
export const DOCUMENT_TOOL_MAX_SEARCH_HITS = 20;
export const DOCUMENT_TOOL_MAX_SECTION_CHARS = 4_000;

const DOC_ID_PATTERN = /^[0-9a-f]{32}$/;

export class DocumentToolStore {
  constructor({ ttlMs = DOCUMENT_TOOL_TTL_MS, maxDocs = DOCUMENT_TOOL_MAX_DOCS } = {}) {
    this.ttlMs = ttlMs;
    this.maxDocs = maxDocs;
    this.docs = new Map();
  }

  put({ name, kind, text, sheets, keyId }) {
    this.prune();
    const id = crypto.randomBytes(16).toString('hex');
    this.docs.set(id, {
      id,
      keyId: String(keyId || ''),
      name: String(name || 'documento').slice(0, 160),
      kind: String(kind || 'txt').slice(0, 8),
      text: String(text || '').slice(0, DOCUMENT_MAX_CHARS),
      sheets: Array.isArray(sheets) ? sheets.slice(0, 24).map((sheet) => ({
        name: String(sheet?.name || '').slice(0, 120),
        rows: Number(sheet?.rows) || 0,
        columns: Number(sheet?.columns) || 0,
        hidden: Boolean(sheet?.hidden)
      })) : [],
      expiresAt: Date.now() + this.ttlMs
    });
    while (this.docs.size > this.maxDocs) this.docs.delete(this.docs.keys().next().value);
    return this.docs.get(id);
  }

  prune(now = Date.now()) {
    for (const [id, doc] of this.docs) if (doc.expiresAt <= now) this.docs.delete(id);
  }

  // Un ID de documento sólo lo resuelve la clave que lo subió: así un ID
  // adivinado o filtrado no expone el archivo de otro usuario.
  find(docId, keyId) {
    this.prune();
    const doc = DOC_ID_PATTERN.test(String(docId || '')) ? this.docs.get(String(docId)) : null;
    if (!doc || doc.expiresAt <= Date.now()) return null;
    if (keyId !== undefined && doc.keyId !== String(keyId || '')) return null;
    return doc;
  }
}

// Las hojas se guardan como filas separadas por tabuladores con cabeceras
// "#\tA\tB…"; aquí se vuelven a trocear para poder leer rangos por hoja.
function sheetRowsFromBlock(block) {
  const lines = block.split('\n').filter((line) => line.trim() && !line.startsWith('#\t'));
  return lines.map((line) => line.split('\t'));
}

function parseSheetBlocks(text) {
  const blocks = [];
  const pattern = /^--- Hoja "([^"]*)" ·[^\n]*---$/gm;
  let match = pattern.exec(text);
  while (match) {
    // Se captura el inicio del cuerpo antes de buscar el siguiente encabezado:
    // el propio exec siguiente mueve lastIndex.
    const bodyStart = pattern.lastIndex;
    const next = pattern.exec(text);
    const end = next ? next.index : text.length;
    blocks.push({ name: match[1], body: text.slice(bodyStart, end).trim() });
    if (!next) break;
    match = next;
  }
  return blocks;
}

function clampInteger(value, { min, max, fallback }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function outlineOf(doc) {
  const lines = [];
  lines.push(`Documento: ${doc.name} · tipo ${doc.kind} · ${doc.text.length} caracteres`);
  if (doc.sheets.length) {
    lines.push('Hojas:');
    for (const sheet of doc.sheets) {
      lines.push(`- "${sheet.name}" · ${sheet.rows} filas × ${sheet.columns} columnas${sheet.hidden ? ' (oculta)' : ''}`);
    }
    lines.push('Usa action "rows" con sheet para leer filas, o "search" para localizar un término.');
    return lines.join('\n');
  }
  const headings = doc.text.split('\n').filter((line) => /^#{1,4}\s|^\d+[.)]\s/.test(line)).slice(0, 20);
  if (headings.length) lines.push('Encabezados detectados:', ...headings.map((heading) => `- ${heading.slice(0, 160)}`));
  lines.push('Usa action "text" con offset para leer fragmentos, o "search" para localizar un término.');
  return lines.join('\n');
}

function rowsAction(doc, args) {
  const blocks = parseSheetBlocks(doc.text);
  if (!blocks.length) return 'Este documento no es una hoja de cálculo. Usa action "text" o "search".';
  const requested = String(args.sheet || '').trim().toLowerCase();
  const block = requested
    ? blocks.find((entry) => entry.name.toLowerCase() === requested) || blocks.find((entry) => entry.name.toLowerCase().includes(requested))
    : blocks[0];
  if (!block) {
    return `No existe la hoja "${String(args.sheet || '').slice(0, 120)}". Hojas disponibles: ${blocks.map((entry) => `"${entry.name}"`).join(', ')}.`;
  }
  const rows = sheetRowsFromBlock(block.body);
  if (!rows.length) return `La hoja "${block.name}" no tiene filas legibles.`;
  const start = clampInteger(args.offset ?? 1, { min: 1, max: rows.length, fallback: 1 });
  const limit = clampInteger(args.limit ?? 40, { min: 1, max: DOCUMENT_TOOL_MAX_ROWS, fallback: 40 });
  const slice = rows.slice(start - 1, start - 1 + limit);
  const header = `Hoja "${block.name}" · filas ${start}-${start - 1 + slice.length} de ${rows.length}`;
  return `${header}\n${slice.map((row) => row.join('\t')).join('\n')}`;
}

function textAction(doc, args) {
  const start = clampInteger(args.offset ?? 0, { min: 0, max: doc.text.length, fallback: 0 });
  const limit = clampInteger(args.limit ?? 4000, { min: 1, max: DOCUMENT_TOOL_MAX_SECTION_CHARS, fallback: 4000 });
  const slice = doc.text.slice(start, start + limit);
  if (!slice) return `No hay contenido a partir del carácter ${start} (el documento tiene ${doc.text.length}).`;
  return `Fragmento ${start}-${start + slice.length} de ${doc.text.length} caracteres:\n${slice}`;
}

function searchAction(doc, args) {
  const term = String(args.query || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 120);
  if (!term) return 'Indica un término de búsqueda.';
  const needle = term.toLowerCase();
  const lines = doc.text.split('\n');
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toLowerCase().includes(needle)) continue;
    hits.push(`línea ${index + 1}: ${lines[index].slice(0, 400)}`);
    if (hits.length >= DOCUMENT_TOOL_MAX_SEARCH_HITS) break;
  }
  if (!hits.length) return `Sin coincidencias para "${term}".`;
  return `${hits.length} coincidencia${hits.length === 1 ? '' : 's'} para "${term}":\n${hits.join('\n')}`;
}

export function queryDocument(params) {
  const { doc, action } = params;
  if (!doc) return 'El documento ya no está disponible en el servidor. Vuelve a adjuntarlo.';
  const normalized = String(action || 'outline').trim().toLowerCase();
  if (normalized === 'outline') return outlineOf(doc);
  if (normalized === 'rows') return rowsAction(doc, params);
  if (normalized === 'text') return textAction(doc, params);
  if (normalized === 'search') return searchAction(doc, params);
  return `Acción no admitida "${normalized}". Usa outline, rows, text o search.`;
}

export const DOCUMENT_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'read_document',
    description: 'Lee un documento adjuntado por el usuario (hoja de cálculo, PDF, Word o texto) de forma acotada. No ejecuta nada del archivo. Empieza con action "outline" para ver su estructura y luego usa "rows" (hojas de cálculo), "text" (documentos de texto) o "search" (cualquiera) para leer sólo lo que necesites.',
    parameters: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'ID del documento que aparece en el mensaje del usuario.' },
        action: { type: 'string', enum: ['outline', 'rows', 'text', 'search'], description: 'Qué hacer: estructura, filas de una hoja, fragmento de texto o búsqueda.' },
        sheet: { type: 'string', description: 'Nombre de la hoja (para action "rows").' },
        offset: { type: 'integer', description: 'Fila inicial (rows, desde 1) o carácter inicial (text, desde 0).' },
        limit: { type: 'integer', description: 'Cuántas filas o caracteres devolver como máximo.' },
        query: { type: 'string', description: 'Término a buscar (para action "search").' }
      },
      required: ['doc', 'action']
    }
  }
};

// Resumen que reemplaza al volcado completo cuando el modelo puede consultar el
// documento bajo demanda.
export function summarizeAttachment(doc) {
  const sheetNote = doc.sheets.length
    ? ` Hojas: ${doc.sheets.map((sheet) => `"${sheet.name}" (${sheet.rows}×${sheet.columns})`).join(', ')}.`
    : '';
  return `Documento adjunto id="${doc.id}" nombre="${doc.name.replace(/["<>]/g, '')}" tipo=${doc.kind} longitud=${doc.text.length} caracteres.${sheetNote} Su contenido NO está incluido: consúltalo con la herramienta read_document (action "outline" primero).`;
}

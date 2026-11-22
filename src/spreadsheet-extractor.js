import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

// Lector de hojas de cálculo (.xlsx / .xlsm) pensado para alimentar contexto de
// un modelo. No es un visor: extrae sólo valores cacheados y lo hace con límites
// estrictos, porque el archivo llega de un usuario y un documento malicioso no
// debe tumbar el servidor ni ejecutar nada.
//
// Decisiones de seguridad:
// - No se usa exceljs: su versión 4.4.0 tiene CVE de prototype pollution
//   (definedName que apunta a una hoja "__proto__"). Aquí no se construyen
//   objetos con claves procedentes del archivo: sólo arrays y Map.
// - No se leen fórmulas (`<f>`): sólo el valor cacheado (`<v>`). Nada se evalúa.
// - Se rechaza cualquier XML con DOCTYPE/ENTITY antes de parsear (ni XXE ni
//   expansión de entidades), y se limita el tamaño descomprimido (zip bomb).
// - Se ignora por completo lo que no sea cálculo: macros, dibujos, VBA, rels
//   externos.

export const SPREADSHEET_MAX_ZIP_ENTRIES = 1200;
export const SPREADSHEET_MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const SPREADSHEET_MAX_SHEETS = 24;
export const SPREADSHEET_MAX_ROWS_PER_SHEET = 4000;
export const SPREADSHEET_MAX_COLUMNS = 80;
export const SPREADSHEET_MAX_CELL_CHARS = 2000;
export const SPREADSHEET_MAX_SHARED_STRINGS = 120_000;

const MAX_XML_CHARS = 24 * 1024 * 1024;
// Formatos de fecha/hora integrados de OOXML (numFmtId reservados).
const BUILTIN_DATE_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58
]);
const DATE_TOKEN = /(?:^|[^\\])(?:[dmyhs]|\[[hms]+\])/i;

function parseXml(raw, label) {
  if (raw.length > MAX_XML_CHARS) throw new Error(`${label} es demasiado grande para procesarlo.`);
  // xmldom ya no resuelve entidades externas, pero un DOCTYPE/ENTITY en un
  // archivo no confiable es siempre señal de ataque: se rechaza sin parsear.
  if (/<!(?:DOCTYPE|ENTITY)/i.test(raw)) throw new Error(`${label} contiene declaraciones XML no admitidas.`);
  const document = new DOMParser({ onError: () => {} }).parseFromString(raw, 'text/xml');
  if (!document || document.documentElement?.nodeName === 'parsererror') {
    throw new Error(`${label} está dañado.`);
  }
  return document;
}

function childrenOf(node, tagName) {
  const found = [];
  for (let i = 0; i < (node?.childNodes?.length || 0); i += 1) {
    const child = node.childNodes[i];
    if (child.nodeType === 1 && (child.localName || child.nodeName) === tagName) found.push(child);
  }
  return found;
}

function elementsByLocalName(root, tagName) {
  const found = [];
  if (!root || root.nodeType !== 1) return found;
  // La propia raíz también puede ser el elemento buscado (p. ej. <Relationships>).
  if ((root.localName || root.nodeName) === tagName) found.push(root);
  const walk = (node) => {
    for (let i = 0; i < (node?.childNodes?.length || 0); i += 1) {
      const child = node.childNodes[i];
      if (child.nodeType !== 1) continue;
      if ((child.localName || child.nodeName) === tagName) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function attr(node, name) {
  return node?.getAttribute?.(name) ?? '';
}

// "BC7" -> { column: 54, row: 7 }. Sin la referencia, la celda va a la
// siguiente posición libre de la fila.
function parseCellReference(reference) {
  const match = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(String(reference || ''));
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + (char.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) - 1 };
}

export function columnLabel(index) {
  let label = '';
  let cursor = index + 1;
  while (cursor > 0) {
    const remainder = (cursor - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    cursor = Math.floor((cursor - 1) / 26);
  }
  return label;
}

// Excel guarda fechas como días desde 1899-12-30 (epoch 1900) o 1904-01-01.
// Sin esta conversión el modelo vería "45352" donde el usuario ve "01/01/2024".
function serialToIsoDate(serial, use1904) {
  const daysPerDay = serial - Math.floor(serial);
  const baseMs = use1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const stamp = baseMs + Math.floor(serial) * 86_400_000;
  const date = new Date(stamp);
  if (!Number.isFinite(stamp) || Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString().slice(0, 10);
  if (!daysPerDay) return iso;
  const totalSeconds = Math.round(daysPerDay * 86_400);
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  return `${iso} ${hh}:${mm}`;
}

function readSharedStrings(document) {
  const strings = [];
  for (const item of elementsByLocalName(document.documentElement, 'si')) {
    if (strings.length >= SPREADSHEET_MAX_SHARED_STRINGS) break;
    let text = '';
    for (const part of elementsByLocalName(item, 't')) {
      // Los runs fonéticos (<rPh>) no forman parte del valor visible.
      if (part.parentNode && (part.parentNode.localName || part.parentNode.nodeName) === 'rPh') continue;
      text += part.textContent || '';
      if (text.length > SPREADSHEET_MAX_CELL_CHARS) break;
    }
    strings.push(text.length > SPREADSHEET_MAX_CELL_CHARS ? text.slice(0, SPREADSHEET_MAX_CELL_CHARS) : text);
  }
  return strings;
}

// numFmtId por celda: cellXfs[i].numFmtId, combinando los formatos reservados
// con los personalizados declarados en <numFmts>.
function readDateStyleFlags(document) {
  const flags = [];
  if (!document) return flags;
  const custom = new Map();
  for (const numFmt of elementsByLocalName(document.documentElement, 'numFmt')) {
    const id = Number(attr(numFmt, 'numFmtId'));
    const code = attr(numFmt, 'formatCode');
    if (Number.isInteger(id) && code) custom.set(id, DATE_TOKEN.test(code));
  }
  const cellXfs = elementsByLocalName(document.documentElement, 'cellXfs')[0];
  for (const xf of childrenOf(cellXfs, 'xf')) {
    const id = Number(attr(xf, 'numFmtId'));
    flags.push(custom.has(id) ? custom.get(id) : BUILTIN_DATE_FORMAT_IDS.has(id));
  }
  return flags;
}

function readSheetRows({ document, sharedStrings, dateStyleFlags, use1904 }) {
  const sheetData = elementsByLocalName(document.documentElement, 'sheetData')[0];
  const rows = [];
  let truncated = false;
  for (const rowNode of childrenOf(sheetData, 'row')) {
    if (rows.length >= SPREADSHEET_MAX_ROWS_PER_SHEET) { truncated = true; break; }
    const cells = new Map();
    let nextColumn = 0;
    for (const cellNode of childrenOf(rowNode, 'c')) {
      const reference = parseCellReference(attr(cellNode, 'r'));
      const column = reference ? reference.column : nextColumn;
      nextColumn = column + 1;
      if (column < 0 || column >= SPREADSHEET_MAX_COLUMNS) continue;
      const type = attr(cellNode, 't') || 'n';
      let value = '';
      if (type === 'inlineStr') {
        const inline = childrenOf(cellNode, 'is')[0];
        value = inline ? elementsByLocalName(inline, 't').map((node) => node.textContent || '').join('') : '';
      } else {
        const valueNode = childrenOf(cellNode, 'v')[0];
        const raw = valueNode?.textContent ?? '';
        if (type === 's') {
          const index = Number(raw);
          value = Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : '';
        } else if (type === 'e') {
          value = `(${raw || 'error'})`;
        } else if (type === 'b') {
          value = raw === '1' ? 'VERDADERO' : 'FALSO';
        } else if (type === 'str') {
          value = raw;
        } else {
          const number = Number(raw);
          if (raw !== '' && Number.isFinite(number) && dateStyleFlags[Number(attr(cellNode, 's'))] && number > 0) {
            value = serialToIsoDate(number, use1904) ?? raw;
          } else {
            value = raw;
          }
        }
      }
      value = String(value).replace(/\s+/g, ' ').trim();
      if (value) cells.set(column, value.length > SPREADSHEET_MAX_CELL_CHARS ? `${value.slice(0, SPREADSHEET_MAX_CELL_CHARS)}…` : value);
    }
    const usedColumns = [...cells.keys()];
    if (!usedColumns.length) continue;
    const lastColumn = Math.min(Math.max(...usedColumns), SPREADSHEET_MAX_COLUMNS - 1);
    const row = [];
    for (let column = 0; column <= lastColumn; column += 1) row.push(cells.get(column) ?? '');
    rows.push({ number: parseCellReference(`A${attr(rowNode, 'r') || rows.length + 1}`)?.row ?? rows.length, values: row });
  }
  return { rows, truncated };
}

function resolveSheetTargets(workbookDocument, relsDocument) {
  const targets = new Map();
  for (const relationship of childrenOf(elementsByLocalName(relsDocument.documentElement, 'Relationships')[0], 'Relationship')) {
    const id = attr(relationship, 'Id');
    const target = attr(relationship, 'Target');
    if (id && target && !/^[a-z]+:/i.test(target)) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = [];
  const bookViews = elementsByLocalName(workbookDocument.documentElement, 'sheets')[0];
  for (const sheet of childrenOf(bookViews, 'sheet')) {
    const name = attr(sheet, 'name') || `Hoja ${sheets.length + 1}`;
    const relationshipId = attr(sheet, 'r:id') || attr(sheet, 'id');
    const target = targets.get(relationshipId);
    if (target) sheets.push({ name, target, state: attr(sheet, 'state') });
  }
  return sheets;
}

export async function extractSpreadsheet(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { createFolders: false });
  } catch {
    throw new Error('El archivo no es una hoja de cálculo válida (.xlsx).');
  }
  const entries = Object.values(zip.files);
  if (entries.length > SPREADSHEET_MAX_ZIP_ENTRIES) throw new Error('La hoja de cálculo tiene demasiados elementos internos.');
  let uncompressed = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    if ((entry.unixPermissions ?? 0) === 0 && entry.name.startsWith('encry')) {
      throw new Error('La hoja de cálculo está protegida con contraseña.');
    }
    const size = Number(entry._data?.uncompressedSize) || 0;
    uncompressed += size;
    if (uncompressed > SPREADSHEET_MAX_UNCOMPRESSED_BYTES) {
      throw new Error('La hoja de cálculo descomprimida supera el límite permitido.');
    }
  }

  const readText = async (name) => {
    const entry = zip.file(name);
    if (!entry) return null;
    return entry.async('string');
  };

  const workbookRaw = await readText('xl/workbook.xml');
  if (workbookRaw === null) throw new Error('El archivo no contiene una hoja de cálculo (.xlsx).');
  const workbook = parseXml(workbookRaw, 'El libro de la hoja de cálculo');
  const use1904 = /date1904="1"|date1904="true"/i.test(workbookRaw);
  const relsRaw = await readText('xl/_rels/workbook.xml.rels');
  const rels = relsRaw === null ? null : parseXml(relsRaw, 'Las relaciones del libro');
  const declaredSheets = rels ? resolveSheetTargets(workbook, rels) : [];
  if (!declaredSheets.length) throw new Error('La hoja de cálculo no contiene hojas legibles.');

  const sharedStringsRaw = await readText('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsRaw ? readSharedStrings(parseXml(sharedStringsRaw, 'Las cadenas compartidas')) : [];
  const stylesRaw = await readText('xl/styles.xml');
  const dateStyleFlags = stylesRaw ? readDateStyleFlags(parseXml(stylesRaw, 'Los estilos de la hoja de cálculo')) : [];

  const sheets = [];
  let truncated = false;
  for (const sheet of declaredSheets) {
    if (sheets.length >= SPREADSHEET_MAX_SHEETS) { truncated = true; break; }
    const raw = await readText(`xl/${sheet.target}`);
    if (raw === null) continue;
    let parsed;
    try {
      parsed = parseXml(raw, `La hoja "${sheet.name}"`);
    } catch (error) {
      sheets.push({ name: sheet.name, hidden: sheet.state === 'hidden' || sheet.state === 'veryHidden', rows: [], columns: 0, truncated: false, error: error.message });
      continue;
    }
    const { rows, truncated: rowsTruncated } = readSheetRows({ document: parsed, sharedStrings, dateStyleFlags, use1904 });
    if (rowsTruncated) truncated = true;
    const columns = rows.reduce((widest, row) => Math.max(widest, row.values.length), 0);
    sheets.push({
      name: sheet.name,
      hidden: sheet.state === 'hidden' || sheet.state === 'veryHidden',
      rows: rows.map((row) => row.values),
      rowNumbers: rows.map((row) => row.number + 1),
      columns,
      truncated: rowsTruncated
    });
  }
  if (!sheets.length) throw new Error('No se ha podido leer ninguna hoja de cálculo.');

  const blocks = sheets.map((sheet) => {
    const header = `--- Hoja "${sheet.name}" · ${sheet.rows.length} fila${sheet.rows.length === 1 ? '' : 's'} × ${sheet.columns} columna${sheet.columns === 1 ? '' : 's'}${sheet.hidden ? ' · oculta' : ''}${sheet.truncated ? ' · recortada' : ''} ---`;
    if (sheet.error) return `${header}\n(No se pudo leer esta hoja: ${sheet.error})`;
    if (!sheet.rows.length) return `${header}\n(sin contenido)`;
    const lines = [];
    if (sheet.columns > 1) {
      lines.push(['#', ...Array.from({ length: sheet.columns }, (_value, index) => columnLabel(index))].join('\t'));
    }
    sheet.rows.forEach((values, index) => lines.push([String(sheet.rowNumbers[index]), ...values].join('\t')));
    return `${header}\n${lines.join('\n')}`;
  });

  return {
    text: blocks.join('\n\n'),
    truncated,
    sheets: sheets.map(({ name, rows, columns, hidden, truncated: sheetTruncated, error }) => ({ name, rows: rows.length, columns, hidden, truncated: sheetTruncated, ...(error ? { error } : {}) }))
  };
}

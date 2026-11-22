import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';

import { extractSpreadsheet } from '../src/spreadsheet-extractor.js';
import { extractDocument, documentKind } from '../src/document-extractor.js';

// Construye un .xlsx real a partir de las partes XML, igual que haría Excel.
async function buildWorkbook({ sheets, sharedStrings = '', styles = '', date1904 = false, extra = {} }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets>${sheets
    .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" state="${sheet.state || 'visible'}" r:id="rId${index + 1}"/>`)
    .join('')}</sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships>${sheets
    .map((sheet, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('')}</Relationships>`);
  sheets.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0"?><worksheet><sheetData>${sheet.rows}</sheetData></worksheet>`);
  });
  if (sharedStrings) zip.file('xl/sharedStrings.xml', `<?xml version="1.0"?><sst>${sharedStrings}</sst>`);
  if (styles) zip.file('xl/styles.xml', styles);
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const cellXfs = (numFmtIds) => `<?xml version="1.0"?><styleSheet><cellXfs count="${numFmtIds.length}">${numFmtIds
  .map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0"/>`)
  .join('')}</cellXfs></styleSheet>`;

test('lee una hoja con texto compartido, números y celdas vacías', async () => {
  const buffer = await buildWorkbook({
    sharedStrings: '<si><t>Producto</t></si><si><t>Café</t></si><si><t>Español</t><rPh><t>acento</t></rPh></si>',
    sheets: [{ name: 'Ventas', rows: [
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>',
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>12.5</v></c></row>',
      '<row r="5"><c r="C5"><v>7</v></c></row>'
    ] }]
  });
  const result = await extractSpreadsheet(buffer);
  assert.equal(result.sheets[0].name, 'Ventas');
  assert.equal(result.sheets[0].columns, 3);
  assert.match(result.text, /Producto\tEspañol/);
  assert.match(result.text, /Café\t12\.5/);
  // La fila 5 conserva su número real y las columnas vacías quedan como tabuladores.
  assert.match(result.text, /^5\t\t\t7$/m);
});

test('convierte fechas numéricas a texto legible y respeta el epoch 1904', async () => {
  // 45292 es el serial OOXML (epoch 1900) del 2024-01-01.
  const buffer = await buildWorkbook({
    styles: cellXfs([0, 14, 22]),
    sheets: [{ name: 'Fechas', rows: [
      '<row r="1"><c r="A1" s="1"><v>45292</v></c><c r="B1" s="2"><v>45292.5</v></c><c r="C1"><v>45292</v></c></row>'
    ] }]
  });
  const result = await extractSpreadsheet(buffer);
  assert.match(result.text, /2024-01-01/);
  assert.match(result.text, /2024-01-01 12:00/);
  // Sin estilo de fecha el número se queda como número.
  assert.match(result.text, /\t45292$/m);
});

test('usa el epoch 1904 cuando el libro lo declara', async () => {
  const buffer = await buildWorkbook({
    date1904: true,
    styles: cellXfs([0, 14]),
    sheets: [{ name: 'Fechas1904', rows: ['<row r="1"><c r="A1" s="1"><v>45292</v></c></row>'] }]
  });
  const result = await extractSpreadsheet(buffer);
  assert.match(result.text, /2028-01-02/);
});

test('ignora fórmulas y macros: sólo usa el valor cacheado', async () => {
  const buffer = await buildWorkbook({
    sheets: [{ name: 'Calc', rows: [
      '<row r="1"><c r="A1"><f>=SUMA(1,2)</f><v>3</v></c><c r="B1" t="e"><v>#REF!</v></c><c r="C1" t="b"><v>1</v></c></row>'
    ] }],
    extra: { 'xl/vbaProject.bin': 'CONTENIDO-DE-MACRO' }
  });
  const result = await extractSpreadsheet(buffer);
  assert.match(result.text, /\t3\t\(#REF!\)\tVERDADERO/);
  assert.doesNotMatch(result.text, /SUMA|vbaProject|CONTENIDO-DE-MACRO/);
});

test('rechaza XML con DOCTYPE o ENTITY antes de parsearlo', async () => {
  const entity = '<!DOCTYPE worksheet [<!ENTITY xxe "ROBADO">]><worksheet><sheetData><row r="1"><c r="A1"><v>&xxe;</v></c></row></sheetData></worksheet>';
  const buffer = await buildWorkbook({ sheets: [{ name: 'XXE', rows: '' }], extra: { 'xl/worksheets/sheet1.xml': entity } });
  const result = await extractSpreadsheet(buffer);
  assert.doesNotMatch(result.text, /ROBADO/);
  assert.match(result.text, /No se pudo leer esta hoja/);
});

test('limita hojas, filas y columnas en lugar de leer un archivo desbordante', async () => {
  const manyRows = Array.from({ length: 5005 }, (_unused, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`).join('');
  const manySheets = Array.from({ length: 30 }, (_unused, index) => ({ name: `H${index}`, rows: '<row r="1"><c r="A1"><v>1</v></c></row>' }));
  const buffer = await buildWorkbook({ sheets: [...manySheets, { name: 'Larga', rows: manyRows }] });
  const result = await extractSpreadsheet(buffer);
  assert.ok(result.sheets.length <= 24, `hojas: ${result.sheets.length}`);
  assert.equal(result.truncated, true);
});

test('rechaza archivos que no son una hoja de cálculo', async () => {
  await assert.rejects(extractSpreadsheet(Buffer.from('no soy un zip')), /no es una hoja de cálculo válida/);
  const zip = new JSZip();
  zip.file('hola.txt', 'texto suelto');
  await assert.rejects(extractSpreadsheet(await zip.generateAsync({ type: 'nodebuffer' })), /no contiene una hoja de cálculo/);
});

test('el extractor de documentos acepta .xlsx y .xlsm por extensión', async () => {
  assert.equal(documentKind('ventas.XLSX'), '.xlsx');
  assert.equal(documentKind('macro.xlsm'), '.xlsm');
  const buffer = await buildWorkbook({ sheets: [{ name: 'Hoja1', rows: '<row r="1"><c r="A1"><v>42</v></c></row>' }] });
  const result = await extractDocument({ filename: 'ventas.xlsx', buffer });
  assert.equal(result.kind, 'xlsx');
  assert.match(result.text, /Hoja1/);
  assert.equal(result.sheets[0].rows, 1);
});

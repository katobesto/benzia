import assert from 'node:assert/strict';
import test from 'node:test';

import { documentKind, extractDocument } from '../src/document-extractor.js';

test('reconoce los documentos admitidos sin confiar en mayúsculas', () => {
  assert.equal(documentKind('informe.PDF'), '.pdf');
  assert.equal(documentKind('notas.md'), '.md');
  assert.equal(documentKind('programa.exe'), null);
});

test('extrae y normaliza documentos de texto', async () => {
  const result = await extractDocument({
    filename: 'notas.txt',
    buffer: Buffer.from('Primera línea\r\n\r\nSegunda línea\0')
  });
  assert.equal(result.kind, 'txt');
  assert.equal(result.text, 'Primera línea\n\nSegunda línea');
  assert.equal(result.truncated, false);
});

test('rechaza formatos de documento no admitidos', async () => {
  await assert.rejects(
    extractDocument({ filename: 'archivo.exe', buffer: Buffer.from('contenido') }),
    /Formato no admitido/
  );
});

test('extrae el texto de un PDF real y limpia la carga de pdfjs', async () => {
  // PDF mínimo válido: una página con el texto "Hola benzIA".
  const pdf = Buffer.from([
    '%PDF-1.4',
    '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
    '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
    '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj',
    '4 0 obj <</Length 43>> stream',
    'BT /F1 24 Tf 72 720 Td (Hola benzIA) Tj ET',
    'endstream',
    'endobj',
    '5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj',
    'trailer <</Root 1 0 R /Size 6>>',
    '%%EOF'
  ].join('\n'));
  const result = await extractDocument({ filename: 'prueba.pdf', buffer: pdf });
  assert.equal(result.kind, 'pdf');
  assert.match(result.text, /Hola benzIA/);
  assert.match(result.text, /Página 1/);
  assert.equal(result.truncated, false);
});

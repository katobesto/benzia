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

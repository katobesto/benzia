import assert from 'node:assert/strict';
import test from 'node:test';

import { DocumentToolStore, queryDocument } from '../src/document-tools.js';

const sheetText = [
  '--- Hoja "Ventas" · 3 filas × 2 columnas ---',
  '#\tA\tB',
  '1\tProducto\tVentas',
  '2\tCafé\t1250',
  '3\tOficina\t430',
  '',
  '--- Hoja "Gastos" · 1 fila × 2 columnas ---',
  '#\tA\tB',
  '1\tTotal\t99'
].join('\n');

const store = new DocumentToolStore();
const doc = store.put({ name: 'ventas.xlsx', kind: 'xlsx', text: sheetText, sheets: [
  { name: 'Ventas', rows: 3, columns: 2 }, { name: 'Gastos', rows: 1, columns: 2 }
], keyId: 'key-1' });

test('outline describe las hojas sin volcar su contenido', () => {
  const outline = queryDocument({ doc, action: 'outline' });
  assert.match(outline, /ventas\.xlsx/);
  assert.match(outline, /"Ventas" · 3 filas × 2 columnas/);
  assert.doesNotMatch(outline, /Café/);
});

test('rows devuelve el rango pedido de una hoja concreta', () => {
  const rows = queryDocument({ doc, action: 'rows', sheet: 'Ventas', offset: 2, limit: 2 });
  assert.match(rows, /Hoja "Ventas" · filas 2-3 de 3/);
  assert.match(rows, /Café\t1250/);
  assert.match(rows, /Oficina\t430/);
  assert.doesNotMatch(rows, /Producto/);
  const other = queryDocument({ doc, action: 'rows', sheet: 'Gastos' });
  assert.match(other, /Total\t99/);
  assert.doesNotMatch(other, /Café/);
});

test('una hoja inexistente lista las disponibles', () => {
  const result = queryDocument({ doc, action: 'rows', sheet: 'Nope' });
  assert.match(result, /No existe la hoja "Nope"/);
  assert.match(result, /"Ventas", "Gastos"/);
});

test('search localiza términos y text acota el fragmento', () => {
  assert.match(queryDocument({ doc, action: 'search', query: 'café' }), /línea 4: 2\tCafé\t1250/);
  assert.match(queryDocument({ doc, action: 'search', query: 'inexistente' }), /Sin coincidencias/);
  const fragment = queryDocument({ doc, action: 'text', offset: 0, limit: 20 });
  assert.equal(fragment.split('\n').slice(1).join('\n').length, 20);
});

test('los límites se aplican aunque el modelo pida de más', () => {
  const rows = queryDocument({ doc, action: 'rows', sheet: 'Ventas', offset: -50, limit: 999_999 });
  assert.match(rows, /filas 1-3 de 3/);
  const unknown = queryDocument({ doc, action: 'ejecutar_comando' });
  assert.match(unknown, /Acción no admitida/);
});

test('un documento sólo lo lee la clave que lo subió y caduca', () => {
  assert.equal(store.find(doc.id, 'key-2'), null);
  assert.equal(store.find(doc.id, 'key-1')?.id, doc.id);
  assert.equal(store.find(doc.id.toUpperCase(), 'key-1'), null);
  const expired = new DocumentToolStore({ ttlMs: -1 });
  const old = expired.put({ name: 'viejo.txt', kind: 'txt', text: 'hola', keyId: 'key-1' });
  assert.equal(expired.find(old.id, 'key-1'), null);
  assert.match(queryDocument({ doc: null, action: 'outline' }), /ya no está disponible/);
});

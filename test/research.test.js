import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeResearchMessages, parseResearchPlan } from '../src/research.js';

test('conserva una ventana amplia de conversación para planificar búsquedas', () => {
  const messages = normalizeResearchMessages([
    { role: 'user', content: 'Háblame de los Mac Studio.' },
    { role: 'assistant', content: 'Apple ha presentado distintas generaciones.' },
    { role: 'user', content: 'Busca los últimos modelos presentados.' }
  ]);
  const plan = parseResearchPlan('{"topic":"Mac Studio recientes","queries":["Apple Mac Studio últimos modelos presentados","site:apple.com newsroom Mac Studio"]}', messages);
  assert.equal(plan.topic, 'Mac Studio recientes');
  assert.equal(plan.shouldSearch, true);
  assert.deepEqual(plan.queries, ['Apple Mac Studio últimos modelos presentados', 'site:apple.com newsroom Mac Studio']);
});

test('puede omitir Brave cuando el planificador no necesita información web', () => {
  const messages = normalizeResearchMessages([
    { role: 'user', content: 'Escribe una felicitación breve y cordial para mi equipo.' }
  ]);
  const plan = parseResearchPlan('{"topic":"felicitación al equipo","should_search":false,"queries":[]}', messages);
  assert.equal(plan.shouldSearch, false);
  assert.deepEqual(plan.queries, []);
});

test('usa una consulta contextual de respaldo cuando el planificador no devuelve JSON', () => {
  const messages = normalizeResearchMessages([
    { role: 'user', content: 'Háblame de los Mac Studio.' },
    { role: 'user', content: 'Busca los últimos modelos presentados.' }
  ]);
  const plan = parseResearchPlan('No se pudo generar JSON', messages);
  assert.match(plan.queries[0], /Mac Studio/);
  assert.match(plan.queries[0], /últimos modelos/);
});

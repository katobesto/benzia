import assert from 'node:assert/strict';
import test from 'node:test';

import { LiveActivity } from '../src/live-activity.js';

test('expone streams activos y los retira al terminar', () => {
  let now = 1000;
  const activity = new LiveActivity({ now: () => now });
  activity.begin({ id: 'req-1', keyId: 'key-1', keyName: 'Pruebas', path: '/v1/chat/completions', model: 'modelo', startedAt: 0 });
  assert.equal(activity.snapshot().streams[0].status, 'waiting');
  activity.update('req-1', 'una respuesta que ya está siendo emitida');
  now = 2000;
  activity.update('req-1', 'una respuesta que ya está siendo emitida con más contenido generado');
  const snapshot = activity.snapshot();
  assert.equal(snapshot.activeStreams, 1);
  assert.equal(snapshot.streams[0].status, 'emitting');
  assert.ok(snapshot.streams[0].outputTokensApprox > 0);
  assert.ok(snapshot.tokensPerSecond > 0);
  activity.finish('req-1');
  assert.equal(activity.snapshot().activeStreams, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('benzIA espera 15 minutos por las cabeceras del proveedor si no se configura otro plazo', () => {
  const previous = process.env.REQUEST_TIMEOUT_MS;
  try {
    delete process.env.REQUEST_TIMEOUT_MS;
    assert.equal(loadConfig().requestTimeoutMs, 900_000);
    process.env.REQUEST_TIMEOUT_MS = '1200000';
    assert.equal(loadConfig().requestTimeoutMs, 1_200_000);
  } finally {
    if (previous === undefined) delete process.env.REQUEST_TIMEOUT_MS;
    else process.env.REQUEST_TIMEOUT_MS = previous;
  }
});

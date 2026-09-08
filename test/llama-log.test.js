import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLlamaLogReader, parsePrefillRate } from '../src/llama-log.js';

test('extrae la velocidad de prefill del timing de llama.cpp', () => {
  assert.equal(parsePrefillRate('8.18.967.478 I slot print_timing: prompt eval time = 542.18 ms / 82 tokens (6.61 ms per token, 151.24 tokens per second)'), 151.2);
});

test('lee el último prefill posterior al inicio del stream', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'benzia-llama-log-'));
  const logPath = path.join(dir, 'llama-server.log');
  await fs.writeFile(logPath, '8.18.967.478 I slot print_timing: prompt eval time = 542.18 ms / 82 tokens (6.61 ms per token, 151.24 tokens per second)\n8.48.645.965 I slot print_timing: prompt eval time = 206.17 ms / 54 tokens (3.82 ms per token, 261.92 tokens per second)\n');
  const reader = createLlamaLogReader(logPath);
  const marker = reader.latestPrefillMarker();
  assert.equal(reader.latestPrefillRate(marker - 1), 261.9);
  await fs.rm(dir, { recursive: true, force: true });
});

import fs from 'node:fs/promises';

const PREFILL_PATTERN = /prompt eval time\s*=.*?\(\s*[\d.,]+\s*ms per token,\s*([\d.,]+)\s*tokens per second\s*\)/i;

function parseNumber(value) {
  const normalized = String(value).replace(',', '.');
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
}

function lineClock(line) {
  // llama.cpp usa un reloj monotónico con formato m.ss.mmm.uuu.
  const match = String(line).match(/(?:^|\s)(\d+)\.(\d{2})\.(\d{3})\.(\d{3})(?:\s|$)/);
  if (!match) return null;
  return Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parsePrefillRate(line) {
  const match = String(line).match(PREFILL_PATTERN);
  if (!match) return null;
  const rate = parseNumber(match[1]);
  return rate === null ? null : Math.round(rate * 10) / 10;
}

export function createLlamaLogReader(logPath) {
  const resolvedPath = typeof logPath === 'string' && logPath.trim() ? logPath.trim() : null;

  let offset = 0;
  let remainder = '';
  let latest = null;
  let pending = null;
  let lastRead = 0;
  let identity = null;
  function refresh() {
    if (!resolvedPath || pending || Date.now() - lastRead < 500) return;
    lastRead = Date.now();
    pending = (async () => {
      const handle = await fs.open(resolvedPath, 'r');
      try {
        const stat = await handle.stat();
        const currentIdentity = `${stat.dev}:${stat.ino}`;
        if (identity !== currentIdentity || stat.size < offset) { offset = 0; remainder = ''; latest = null; }
        identity = currentIdentity;
        // On first access or a large backlog, inspect only the tail.
        if (stat.size - offset > 256 * 1024) { offset = Math.max(0, stat.size - 256 * 1024); remainder = ''; }
        const buffer = Buffer.alloc(stat.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        const lines = (remainder + buffer.subarray(0, bytesRead).toString('utf8')).split(/\r?\n/);
        remainder = lines.pop() || '';
        // Logs may finish without a newline; parsing the remainder is safe.
        for (const line of [...lines, remainder]) {
          const rate = parsePrefillRate(line);
          const clock = lineClock(line);
          if (rate !== null && clock !== null) latest = { clock, rate };
        }
      } finally { await handle.close(); }
    })().catch(() => {}).finally(() => { pending = null; });
  }
  refresh();
  return {
    async refresh() { lastRead = 0; refresh(); await pending; },
    latestPrefillMarker() { refresh(); return latest?.clock ?? null; },
    latestPrefillRate(after = -Infinity) { refresh(); return latest && latest.clock > after ? latest.rate : null; }
  };
}

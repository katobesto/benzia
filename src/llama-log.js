import fs from 'node:fs';

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

  function entries() {
    if (!resolvedPath) return [];
    let content;
    try { content = fs.readFileSync(resolvedPath, 'utf8'); } catch { return []; }
    return content.split(/\r?\n/).flatMap((line) => {
      const rate = parsePrefillRate(line);
      const clock = lineClock(line);
      return rate === null || clock === null ? [] : [{ clock, rate }];
    });
  }

  return {
    latestPrefillMarker() {
      return entries().at(-1)?.clock ?? null;
    },
    latestPrefillRate(after = -Infinity) {
      return entries().filter((entry) => entry.clock > after).at(-1)?.rate ?? null;
    }
  };
}

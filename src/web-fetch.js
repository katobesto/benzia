import dns from 'node:dns/promises';
import net from 'node:net';

import { extractPdf } from './document-extractor.js';

export const FETCH_MAX_BYTES = 3 * 1024 * 1024;
export const FETCH_MAX_CHARS = 16_000;
export const FETCH_MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 15_000;

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

function ipv4ToLong(ip) {
  return ip.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

// Bloquea rangos privados, loopback, link-local, CGNAT, multicast y reservados (SSRF).
export function isPrivateAddress(address) {
  let ip = String(address || '').trim();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const value = ipv4ToLong(ip);
    const inBlock = (base, bits) => {
      const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
      return (value & mask) === (base & mask);
    };
    return inBlock(0x00000000, 8)        // 0.0.0.0/8 "esta red"
      || inBlock(0x0A000000, 8)         // 10/8 privado
      || inBlock(0x64400000, 10)        // 100.64/10 CGNAT
      || inBlock(0x7F000000, 8)         // 127/8 loopback
      || inBlock(0xA9FE0000, 16)        // 169.254/16 link-local
      || inBlock(0xAC100000, 12)        // 172.16/12 privado
      || inBlock(0xC0A80000, 16)        // 192.168/16 privado
      || inBlock(0xC0000000, 24)        // 192.0.0/24 IETF
      || inBlock(0xC0000200, 24)        // 192.0.2/24 documentación
      || inBlock(0xC6336400, 24)        // 198.51.100/24 documentación
      || inBlock(0xCB000000, 16)        // 203.0/16 reservado
      || inBlock(0xE0000000, 4)         // multicast (224/4)
      || inBlock(0xF0000000, 4);        // reservado (240/4)
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const embedded = lower.match(/^::ffff:(.+)$/);
    if (embedded) return isPrivateAddress(embedded[1]);   // IPv4 mapeada
    if (lower === '::' || lower === '::1') return true;   // unspecified y loopback
    const first = parseInt(lower.startsWith('::') ? '0' : lower.split(':')[0], 16);
    if (Number.isNaN(first)) return true;
    if (first === 0) return true;                         // ::/8 y equivalentes: conservador
    if ((first & 0xFE00) === 0xFC00) return true;         // fc00::/7 ULA
    if ((first & 0xFFC0) === 0xFE80) return true;         // fe80::/10 link-local
    if ((first & 0xFF00) === 0xFF00) return true;         // ff00::/8 multicast
    return false;
  }
  return true; // cualquier cosa que no sea IP válida se considera no permisible
}

async function assertPublicTarget(url) {
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw Object.assign(new Error('No se permite acceder a direcciones internas.'), { status: 400 });
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw Object.assign(new Error('No se permite acceder a direcciones internas.'), { status: 400 });
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error('No se pudo resolver el nombre del sitio.'), { status: 502 });
  }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw Object.assign(new Error('No se permite acceder a direcciones internas.'), { status: 400 });
  }
}

const decodeEntities = (value) => String(value || '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/gi, '&');

export function extractReadableText(html, maxChars = FETCH_MAX_CHARS) {
  const source = String(html || '');
  const title = decodeEntities(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const text = decodeEntities(source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|hr|(?:\/?)(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre|dd|dt))[ \t>\/]/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const truncated = text.length > maxChars;
  return { title, text: truncated ? text.slice(0, maxChars) : text, truncated };
}

async function readBodyCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw Object.assign(new Error('La página supera el límite de 3 MB.'), { status: 413 });
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('La página supera el límite de 3 MB.'), { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchWebPage({ url, signal, maxBytes = FETCH_MAX_BYTES, maxChars = FETCH_MAX_CHARS }) {
  let current;
  try {
    current = new URL(String(url || ''));
  } catch {
    throw Object.assign(new Error('La dirección de la página no es válida.'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) {
    throw Object.assign(new Error('Sólo se pueden abrir direcciones http o https.'), { status: 400 });
  }
  let response;
  for (let hop = 0; ; hop += 1) {
    await assertPublicTarget(current);
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain,application/pdf,application/json;q=0.9',
          'accept-language': 'es,en;q=0.8',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) benzIA-gateway/1.0'
        },
        signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])])
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw Object.assign(new Error(`No se pudo abrir la página: ${cause?.message || 'error de red'}`), { status: 502, cause });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) break;
      if (hop >= FETCH_MAX_REDIRECTS) throw Object.assign(new Error('La página tiene demasiadas redirecciones.'), { status: 502 });
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw Object.assign(new Error('La página redirige a una dirección no válida.'), { status: 502 });
      }
      if (!['http:', 'https:'].includes(next.protocol)) {
        throw Object.assign(new Error('No se permiten redirecciones fuera de http o https.'), { status: 400 });
      }
      current = next;
      continue;
    }
    break;
  }
  if (!response.ok) {
    throw Object.assign(new Error(`El sitio respondió HTTP ${response.status}.`), { status: response.status === 404 ? 404 : 502 });
  }
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buffer = await readBodyCapped(response, maxBytes);
  const finalUrl = current.toString();
  if (contentType === 'application/pdf') {
    const extracted = await extractPdf(buffer);
    const cleaned = extractReadableText(extracted, maxChars);
    if (!cleaned.text) throw Object.assign(new Error('El PDF no contiene texto legible.'), { status: 422 });
    return { url: finalUrl, title: cleaned.title || '', text: cleaned.text, truncated: cleaned.truncated, contentType };
  }
  if (contentType.includes('html')) {
    const extracted = extractReadableText(new TextDecoder('utf-8').decode(buffer), maxChars);
    if (!extracted.text) throw Object.assign(new Error('La página no contiene texto legible.'), { status: 422 });
    return { url: finalUrl, title: extracted.title, text: extracted.text, truncated: extracted.truncated, contentType };
  }
  if (contentType.startsWith('text/') || contentType === 'application/json' || contentType.endsWith('+json') || contentType.endsWith('+xml')) {
    const extracted = extractReadableText(new TextDecoder('utf-8').decode(buffer), maxChars);
    if (!extracted.text) throw Object.assign(new Error('La página no contiene texto legible.'), { status: 422 });
    return { url: finalUrl, title: extracted.title, text: extracted.text, truncated: extracted.truncated, contentType };
  }
  throw Object.assign(new Error(`Tipo de contenido no admitido (${contentType || 'desconocido'}).`), { status: 415 });
}

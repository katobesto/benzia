import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import multer from 'multer';

import { extractAccessToken } from './access-auth.js';
import { searchBrave, validateSearchQuery } from './brave-search.js';
import { DOCUMENT_MAX_BYTES, documentKind, extractDocument } from './document-extractor.js';
import { jsonBodyErrorHandler } from './http-errors.js';
import { runResearch } from './research.js';
import { RateLimiter } from './rate-limit.js';

const chatPublicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../chat-public');
const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules');

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PREVIEW_MAX_DOCS = 32;
const PREVIEW_MAX_BYTES = 1_100_000;
const PREVIEW_ID_PATTERN = /^[0-9a-f]{36}$/;
const PREVIEW_WRAPPER_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');
const PREVIEW_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: https: blob:",
  "font-src data: https:",
  "connect-src https:",
  "media-src data: https:",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

export function createChatApp({ config, store, rateLimiter: configuredRateLimiter }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'https:', 'http:']
      }
    }
  }));

  const rateLimiter = configuredRateLimiter || new RateLimiter({ limit: config.rateLimitAuthPerMinute || 20 });
  const auth = (req, res, next) => {
    const token = extractAccessToken(req);
    const key = store.findKeyByToken(token, { includeInactive: true });
    if (!key || key.revokedAt) {
      const ip = req.rateLimitAddress || req.socket?.remoteAddress || 'unknown';
      const result = rateLimiter.consume(`auth:${ip}`, { type: 'auth_rate_limit', route: req.path, identity: null, addressFingerprint: rateLimiter.addressFingerprint(req) }, config.rateLimitAuthPerMinute || 20, false);
      if (!result.allowed) {
        const event = { type: 'auth_rate_limit', route: req.path, identity: null, addressFingerprint: rateLimiter.addressFingerprint(req), retryAfterSeconds: result.retryAfterSeconds };
        if (!rateLimiter.shouldLog(event)) return res.set('Retry-After', String(result.retryAfterSeconds)).status(429).json({ error: 'Demasiados intentos de autenticación. Espera antes de volver a intentarlo.', code: 'rate_limited' });
        if (req.securityLog) req.securityLog(event);
        else {
          console.warn(`[seguridad] rate limit activado ${JSON.stringify(event)}`);
          try { store.recordSecurityEvent?.(event); } catch (error) { console.error('No se pudo guardar el evento de seguridad:', error); }
        }
        return res.set('Retry-After', String(result.retryAfterSeconds)).status(429).json({ error: 'Demasiados intentos de autenticación. Espera antes de volver a intentarlo.', code: 'rate_limited' });
      }
    }
    if (!key || key.revokedAt) return res.status(401).json({ error: { message: 'Clave de acceso ausente, revocada o no válida.', type: 'invalid_api_key', code: 'invalid_api_key', param: null } });
    req.accessKey = key;
    return next();
  };
  const applyRateLimit = (req, res, kind) => {
    const key = `key:${req.accessKey.id}:${kind}`;
    const limit = kind === 'inference' ? (config.rateLimitInferencePerMinute || 20) : (config.rateLimitKeyPerMinute || 120);
    const result = rateLimiter.consume(key, { type: `${kind}_rate_limit`, route: req.path, identity: req.accessKey.name, addressFingerprint: rateLimiter.addressFingerprint(req) }, limit, false);
    if (result.allowed) return true;
    const event = { type: `${kind}_rate_limit`, route: req.path, identity: req.accessKey.name, addressFingerprint: rateLimiter.addressFingerprint(req), retryAfterSeconds: result.retryAfterSeconds };
    if (!rateLimiter.shouldLog(event)) {
      res.set('Retry-After', String(result.retryAfterSeconds)).status(429).json({ error: 'Has superado el ritmo máximo de solicitudes. Espera antes de volver a intentarlo.', code: 'rate_limited' });
      return false;
    }
    if (req.securityLog) req.securityLog(event);
    else {
      console.warn(`[seguridad] rate limit activado ${JSON.stringify(event)}`);
      try { store.recordSecurityEvent?.(event); } catch (error) { console.error('No se pudo guardar el evento de seguridad:', error); }
    }
    res.set('Retry-After', String(result.retryAfterSeconds)).status(429).json({ error: 'Has superado el ritmo máximo de solicitudes. Espera antes de volver a intentarlo.', code: 'rate_limited' });
    return false;
  };
  const keyRateLimit = (req, res, next) => applyRateLimit(req, res, 'general') ? next() : undefined;
  const inferenceRateLimit = (req, res, next) => applyRateLimit(req, res, 'inference') ? next() : undefined;
  app.use(express.json({ limit: '16kb' }));
  const braveSettings = () => {
    const settings = store.getSettings();
    return {
      endpoint: settings.braveSearchEndpoint || config.braveSearchEndpoint,
      apiKey: settings.braveSearchApiKey ?? config.braveSearchApiKey
    };
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: DOCUMENT_MAX_BYTES },
    fileFilter: (_req, file, done) => done(null, Boolean(documentKind(file.originalname)))
  });
  const previewDocs = new Map();
  const prunePreviews = (now = Date.now()) => {
    for (const [id, doc] of previewDocs) if (doc.expiresAt <= now) previewDocs.delete(id);
    while (previewDocs.size > PREVIEW_MAX_DOCS) previewDocs.delete(previewDocs.keys().next().value);
  };
  const previewStub = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Vista previa</title></head><body><p>Vista previa no disponible o expirada.</p></body></html>';
  const previewWrapper = (docId) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Vista previa HTML · benzIA</title>
<style>html,body{margin:0;width:100%;height:100%;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style>
</head>
<body>
<iframe src="preview-frame?doc=${docId}" sandbox="allow-scripts" referrerpolicy="no-referrer" title="Vista previa del contenido HTML generado"></iframe>
</body>
</html>`;
  const sendPreviewDocument = (res, csp) => {
    res.removeHeader('content-security-policy');
    res.removeHeader('x-frame-options');
    res.removeHeader('cross-origin-opener-policy');
    res.setHeader('content-security-policy', csp);
    res.set('cache-control', 'no-store');
    res.set('referrer-policy', 'no-referrer');
    res.type('html');
  };
  const findPreview = (docId) => {
    const doc = PREVIEW_ID_PATTERN.test(String(docId || '')) ? previewDocs.get(String(docId)) : null;
    return doc && doc.expiresAt > Date.now() ? doc : null;
  };
  app.get('/api/config', auth, (req, res) => {
    res.json({
      endpoint: '/v1',
      identity: { id: req.accessKey.id, name: req.accessKey.name },
      webSearchAvailable: Boolean(braveSettings().apiKey),
      paused: Boolean(req.accessKey.pausedAt)
    });
  });

  app.post('/api/web-search', auth, keyRateLimit, async (req, res) => {
    let query;
    try {
      query = validateSearchQuery(req.body?.query);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const settings = braveSettings();
    try {
      const result = await searchBrave({ endpoint: settings.endpoint, apiKey: settings.apiKey, query });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.message || 'No se pudo completar la búsqueda web.' });
    }
  });

  app.post('/api/research/stream', auth, inferenceRateLimit, async (req, res) => {
    const model = typeof req.body?.model === 'string' ? req.body.model.trim().slice(0, 200) : '';
    if (!model || !Array.isArray(req.body?.messages)) return res.status(400).json({ error: 'Modelo o conversación de investigación no válidos.' });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    res.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.flushHeaders?.();
    const emit = (type, payload) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    };
    if (req.accessKey.pausedAt) {
      emit('research.status', { step: 'disabled', label: 'La búsqueda web no está disponible para este acceso.' });
      emit('research.complete', { sources: [], context: '' });
      return res.end();
    }
    try {
      await runResearch({ config, store, accessKey: req.accessKey, model, messages: req.body.messages, emit, signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) emit('research.error', { message: error.message || 'No se pudo completar la investigación web.' });
    } finally {
      res.off('close', cancel);
    }
    return res.end();
  });

  app.post('/api/attachments/extract', auth, keyRateLimit, (req, res) => {
    upload.single('file')(req, res, async (uploadError) => {
      if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'El documento supera el límite de 6 MB.' });
      }
      if (uploadError) return res.status(400).json({ error: 'No se pudo recibir el documento.' });
      if (!req.file) return res.status(400).json({ error: 'Adjunta un documento PDF, DOCX, TXT, MD, CSV o JSON.' });
      try {
        const extracted = await extractDocument({ buffer: req.file.buffer, filename: req.file.originalname });
        return res.json({
          name: path.basename(req.file.originalname).slice(0, 160),
          type: req.file.mimetype || 'application/octet-stream',
          size: req.file.size,
          ...extracted
        });
      } catch (error) {
        return res.status(422).json({ error: error.message || 'No se pudo leer el documento.' });
      }
    });
  });

  app.post('/api/preview', auth, keyRateLimit, express.text({ limit: '1.2mb', type: 'text/*' }), (req, res) => {
    const html = typeof req.body === 'string' ? req.body : '';
    if (!html.trim()) return res.status(400).json({ error: 'No hay contenido que previsualizar.' });
    if (Buffer.byteLength(html, 'utf8') > PREVIEW_MAX_BYTES) {
      return res.status(413).json({ error: 'El documento supera el límite de la vista previa.' });
    }
    prunePreviews();
    const doc = crypto.randomBytes(18).toString('hex');
    previewDocs.set(doc, { html, expiresAt: Date.now() + PREVIEW_TTL_MS });
    return res.json({ doc });
  });

  app.get('/api/preview', (req, res) => {
    const docId = String(req.query.doc || '');
    if (!findPreview(docId)) return res.status(404).set('cache-control', 'no-store').type('html').send(previewStub);
    sendPreviewDocument(res, PREVIEW_WRAPPER_CSP);
    return res.send(previewWrapper(docId));
  });

  app.get('/api/preview-frame', (req, res) => {
    const docId = String(req.query.doc || '');
    const doc = findPreview(docId);
    if (!doc) return res.status(404).set('cache-control', 'no-store').type('html').send(previewStub);
    sendPreviewDocument(res, PREVIEW_FRAME_CSP);
    return res.send(doc.html);
  });

  app.use((req, res, next) => {
    if (req.path.endsWith('.js')) res.set('cache-control', 'no-store');
    next();
  });
  app.get('/vendor/marked.umd.js', (_req, res) => res.sendFile(path.join(vendorDir, 'marked/lib/marked.umd.js')));
  app.get('/vendor/purify.min.js', (_req, res) => res.sendFile(path.join(vendorDir, 'dompurify/dist/purify.min.js')));
  app.use(express.static(chatPublicDir, { index: false, fallthrough: true }));
  app.get('/', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.sendFile(path.join(chatPublicDir, 'index.html'));
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta de chat no encontrada.' }));
  app.get('*', (_req, res) => res.status(404).send('No encontrado'));

  app.use(jsonBodyErrorHandler);

  return app;
}

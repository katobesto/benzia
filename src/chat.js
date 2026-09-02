import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import multer from 'multer';

import { accessAuth } from './access-auth.js';
import { DOCUMENT_MAX_BYTES, documentKind, extractDocument } from './document-extractor.js';

const chatPublicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../chat-public');
const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules');

export function createChatApp({ config, store }) {
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

  const auth = accessAuth(store);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: DOCUMENT_MAX_BYTES },
    fileFilter: (_req, file, done) => done(null, Boolean(documentKind(file.originalname)))
  });
  app.get('/api/config', auth, (req, res) => {
    const settings = store.getSettings();
    const gatewayBaseUrl = (settings.publicGatewayUrl || config.publicGatewayUrl).replace(/\/+$/, '');
    res.json({
      endpoint: `${gatewayBaseUrl}/v1`,
      identity: { id: req.accessKey.id, name: req.accessKey.name }
    });
  });

  app.post('/api/attachments/extract', auth, (req, res) => {
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

  app.get('/vendor/marked.umd.js', (_req, res) => res.sendFile(path.join(vendorDir, 'marked/lib/marked.umd.js')));
  app.get('/vendor/purify.min.js', (_req, res) => res.sendFile(path.join(vendorDir, 'dompurify/dist/purify.min.js')));
  app.use(express.static(chatPublicDir, { index: false, fallthrough: true }));
  app.get('/', (_req, res) => res.sendFile(path.join(chatPublicDir, 'index.html')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta de chat no encontrada.' }));
  app.get('*', (_req, res) => res.status(404).send('No encontrado'));

  return app;
}

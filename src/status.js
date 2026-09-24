import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';

import { accessAuth, PAUSED_TOKEN_MESSAGE } from './access-auth.js';
import { jsonBodyErrorHandler } from './http-errors.js';
import { buildOverviewPayload } from './overview.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// Read-only status view, structured like the chat app: the shell is public
// and asks the user for one of the access keys created in the admin panel.
// Every data route under /api requires that key. The page only renders the
// dashboard, without sidebar, utilities, settings or token management.
export function createStatusApp({ config, store, liveActivity }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:']
      }
    }
  }));

  const auth = (req, res, next) => {
    accessAuth(store)(req, res, () => {
      if (req.accessKey.pausedAt) {
        return res.status(403).json({ error: req.accessKey.pausedMessage || PAUSED_TOKEN_MESSAGE });
      }
      return next();
    });
  };

  app.get('/', (_req, res) => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('<body>', '<body class="status-mode">')
      .replace('<title>benzIA Console</title>', '<title>Estado · benzIA</title>');
    res.set('cache-control', 'no-store');
    res.type('html').send(html);
  });

  app.get('/api/session', auth, (req, res) => {
    res.json({ authenticated: true, identity: { id: req.accessKey.id, name: req.accessKey.name } });
  });

  app.get('/api/keys', auth, (_req, res) => res.json({ keys: store.listKeys() }));

  app.get('/api/overview', auth, (req, res) => {
    const result = buildOverviewPayload(store, req.query);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result.payload);
  });

  app.get('/api/live', auth, (req, res) => {
    const keyId = typeof req.query.keyId === 'string' ? req.query.keyId : undefined;
    res.json(liveActivity?.snapshot({ keyId }) || { activeStreams: 0, tokensPerSecond: 0, streams: [] });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta de estado no encontrada.' }));
  app.use((_req, res) => res.status(404).send('No encontrado'));

  app.use(jsonBodyErrorHandler);

  return app;
}
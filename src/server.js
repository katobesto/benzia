import 'dotenv/config';

import { createAdminApp } from './admin.js';
import { createChatApp } from './chat.js';
import { createStatusApp } from './status.js';
import { loadConfig } from './config.js';
import { createGatewayApp } from './proxy.js';
import { SqliteStore } from './store.js';
import { LiveActivity } from './live-activity.js';
import { createLlamaLogReader } from './llama-log.js';

const config = loadConfig();

if (config.adminPort === config.gatewayPort) {
  console.error('ADMIN_PORT y GATEWAY_PORT deben ser distintos para aislar el panel del gateway.');
  process.exit(1);
}

const store = new SqliteStore(config.dataDir, config.metricsRetentionDays);
await store.init();
const liveActivity = new LiveActivity({ prefillRateReader: createLlamaLogReader(config.llamaCppLogPath) });

const adminApp = createAdminApp({ config, store, liveActivity });
const chatApp = createChatApp({ config, store });
const statusApp = createStatusApp({ config, store, liveActivity });
const gatewayApp = createGatewayApp({ config, store, adminApp, chatApp, statusApp, liveActivity });

const adminServer = adminApp.listen(config.adminPort, config.adminHost, () => {
  console.log(`Panel:   http://localhost:${config.adminPort}`);
  if (config.generatedAdminToken) {
    console.warn('ADMIN_TOKEN no está definido. Token temporal para esta ejecución:');
    console.warn(config.adminToken);
  }
});

const gatewayServer = gatewayApp.listen(config.gatewayPort, config.gatewayHost, () => {
  console.log(`Gateway: ${config.publicGatewayUrl}/v1`);
  console.log(`Dashboard público: ${config.publicGatewayUrl}/dashboard`);
  console.log(`Estado (token de usuario): ${config.publicGatewayUrl}/status`);
  console.log(`Chat público: ${config.publicGatewayUrl}/chat`);
  console.log(`Proveedor IA Local: ${config.upstreamBaseUrl}`);
});

let shuttingDown = false;
const closeServer = (server) => new Promise((resolve) => server.close(resolve));

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: cerrando servicios...`);
  const forceExit = setTimeout(() => {
    console.error('El cierre gradual superó 10 segundos; terminando el proceso.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  adminServer.closeIdleConnections?.();
  gatewayServer.closeIdleConnections?.();
  await Promise.allSettled([closeServer(adminServer), closeServer(gatewayServer)]);
  store.close();
  clearTimeout(forceExit);
  process.exitCode = 0;
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

import 'dotenv/config';

import { createAdminApp } from './admin.js';
import { createChatApp } from './chat.js';
import { loadConfig } from './config.js';
import { createGatewayApp } from './proxy.js';
import { SqliteStore } from './store.js';
import { LiveActivity } from './live-activity.js';

const config = loadConfig();

if (config.adminPort === config.gatewayPort) {
  console.error('ADMIN_PORT y GATEWAY_PORT deben ser distintos para aislar el panel del gateway.');
  process.exit(1);
}

const store = new SqliteStore(config.dataDir, config.metricsRetentionDays);
await store.init();
const liveActivity = new LiveActivity();

const adminApp = createAdminApp({ config, store, liveActivity });
const chatApp = createChatApp({ config, store });
const gatewayApp = createGatewayApp({ config, store, adminApp, chatApp, liveActivity });

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
  console.log(`Chat público: ${config.publicGatewayUrl}/chat`);
  console.log(`Proveedor IA Local: ${config.upstreamBaseUrl}`);
});

const shutdown = async (signal) => {
  console.log(`\n${signal}: cerrando servicios...`);
  adminServer.close();
  gatewayServer.close();
  store.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

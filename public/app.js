const routes = {
  '/': 'dashboard',
  '/dashboard': 'dashboard',
  '/keys': 'keys',
  '/activity': 'activity',
  '/settings': 'settings'
};

const ADMIN_TOKEN_KEY = 'benzIA_admin_token';
const DEFAULT_PAUSED_MESSAGE = 'Su token ha sido deshabilitado por el administrador. Consulte con Benzo para evaluar si se trata de un problema de pago o personal.';
const legacyAdminToken = sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
const rememberedAdminToken = localStorage.getItem(ADMIN_TOKEN_KEY) || legacyAdminToken;
if (legacyAdminToken && !localStorage.getItem(ADMIN_TOKEN_KEY)) localStorage.setItem(ADMIN_TOKEN_KEY, legacyAdminToken);
sessionStorage.removeItem(ADMIN_TOKEN_KEY);
const pageName = routes[window.location.pathname.replace(/\/$/, '') || '/'] || 'dashboard';
const state = { token: rememberedAdminToken, keys: [], overview: null, live: null, settings: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const compactNumber = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
const exactNumber = new Intl.NumberFormat('es-ES');
const dateTime = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
let chartModel = null;

function initializeRoute() {
  $$('[data-page]').forEach((page) => page.classList.toggle('active', page.dataset.page === pageName));
  $$('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.route === pageName));
  $('#breadcrumb-page').textContent = pageName === 'keys' ? 'CLAVES API' : pageName.toUpperCase();
  document.title = `${pageName === 'keys' ? 'Claves API' : pageName[0].toUpperCase() + pageName.slice(1)} · benzIA`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-admin-token': state.token, ...(options.headers || {}) }
  });
  if (response.status === 401) {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    state.token = '';
    showAuth();
    throw new Error('El token administrativo no es válido.');
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
  return payload;
}

function showAuth() {
  $('#auth-screen').classList.add('auth-required');
  $('#auth-screen').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#admin-token').focus(), 0);
}
function hideAuth() {
  $('#auth-screen').classList.remove('auth-required');
  $('#auth-screen').setAttribute('aria-hidden', 'true');
}
function revealApp() { document.body.classList.add('app-ready'); }

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => element.classList.remove('show'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function localDateBoundary(value, endOfDay = false) {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return date.toISOString();
}

function overviewQuery() {
  const activity = pageName === 'activity';
  const keyId = $(activity ? '#activity-key-filter' : '#key-filter').value;
  const from = $(activity ? '#activity-from-date' : '#from-date').value;
  const to = $(activity ? '#activity-to-date' : '#to-date').value;
  const hours = $(activity ? '#activity-range' : '#range-filter').value;
  const fromBoundary = localDateBoundary(from);
  const toBoundary = localDateBoundary(to, true);
  const range = fromBoundary || toBoundary
    ? `${fromBoundary ? `from=${encodeURIComponent(fromBoundary)}` : ''}${toBoundary ? `${fromBoundary ? '&' : ''}to=${encodeURIComponent(toBoundary)}` : ''}`
    : `hours=${encodeURIComponent(hours)}`;
  return `${range}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`;
}

async function loadAll() {
  const requests = [api('/admin/api/keys'), api('/admin/api/settings')];
  if (pageName === 'dashboard' || pageName === 'activity') requests.push(api(`/admin/api/overview?${overviewQuery()}`));
  const [[keyData, settings, overview], live] = await Promise.all([
    Promise.all(requests),
    pageName === 'dashboard' ? api('/admin/api/live') : Promise.resolve(null)
  ]);
  state.keys = keyData.keys;
  state.settings = settings;
  state.overview = overview || null;
  state.live = live;
  renderKeyFilter();
  renderKeys();
  renderSettings();
  if (state.overview) renderOverview();
  if (state.live) renderLive();
  checkUpstream();
}

async function refreshOverview() {
  state.overview = await api(`/admin/api/overview?${overviewQuery()}`);
  renderOverview();
}

async function refreshLive() {
  const keyId = $('#key-filter').value;
  state.live = await api(`/admin/api/live${keyId ? `?keyId=${encodeURIComponent(keyId)}` : ''}`);
  renderLive();
}

function renderKeyFilter() {
  const dashboardSelect = $('#key-filter');
  const dashboardSelected = dashboardSelect.value;
  dashboardSelect.innerHTML = '<option value="">Todas las claves</option>' + state.keys
    .filter((key) => !key.revokedAt)
    .map((key) => `<option value="${escapeHtml(key.id)}">${escapeHtml(key.name)}${key.pausedAt ? ' (pausada)' : ''}</option>`).join('');
  if ([...dashboardSelect.options].some((option) => option.value === dashboardSelected)) dashboardSelect.value = dashboardSelected;

  const activitySelect = $('#activity-key-filter');
  const activitySelected = activitySelect.value;
  activitySelect.innerHTML = '<option value="">Todos los tokens</option>' + state.keys.map((key) => {
    const stateLabel = key.revokedAt ? ' · revocada' : key.pausedAt ? ' · pausada' : '';
    return `<option value="${escapeHtml(key.id)}">${escapeHtml(key.name)} · ${escapeHtml(key.prefix)}…${stateLabel}</option>`;
  }).join('');
  if ([...activitySelect.options].some((option) => option.value === activitySelected)) activitySelect.value = activitySelected;
}

function renderOverview() {
  const { totals, timeline, byKey, recent } = state.overview;
  $('#metric-total-tokens').textContent = compactNumber.format(totals.inputTokens + totals.outputTokens);
  $('#metric-input').textContent = compactNumber.format(totals.inputTokens);
  $('#metric-output').textContent = compactNumber.format(totals.outputTokens);
  $('#metric-requests').textContent = exactNumber.format(totals.requests);
  $('#metric-errors').textContent = exactNumber.format(totals.errors);
  const lmRate = totals.lmCacheHitRate;
  const lmUncachedInputTokens = Number.isFinite(totals.lmUncachedInputTokens)
    ? totals.lmUncachedInputTokens
    : Math.max(0, totals.lmReportedInputTokens - totals.lmCachedInputTokens);
  $('#metric-lm-cache-rate').textContent = lmRate === null ? '—' : `${Math.round(lmRate * 100)}%`;
  $('#metric-lm-cached').textContent = compactNumber.format(totals.lmCachedInputTokens);
  $('#metric-lm-uncached').textContent = compactNumber.format(lmUncachedInputTokens);
  $('#metric-latency').innerHTML = `${exactNumber.format(totals.averageLatencyMs)} <small>ms</small>`;
  $('#metric-throughput').innerHTML = totals.averageTokensPerSecond === null
    ? '—'
    : `${exactNumber.format(totals.averageTokensPerSecond)} <small>tok/s</small>`;
  $('#metric-throughput-detail').textContent = totals.throughputSamples
    ? `${exactNumber.format(totals.throughputSamples)} emisiones · ${exactNumber.format(totals.throughputReportedRequests)} Proveedor IA Local / ${exactNumber.format(totals.throughputEstimatedRequests)} estimadas`
    : 'sin emisiones medidas en el periodo';
  $('#historical-throughput').textContent = totals.averageTokensPerSecond === null
    ? 'sin histórico todavía'
    : `media del periodo ${exactNumber.format(totals.averageTokensPerSecond)} tok/s`;
  $('#lm-cache-rate').textContent = lmRate === null ? 'No reportado' : `${Math.round(lmRate * 100)}%`;
  $('#lm-cache-cached').textContent = compactNumber.format(totals.lmCachedInputTokens);
  $('#lm-cache-uncached').textContent = compactNumber.format(lmUncachedInputTokens);
  $('#lm-cache-reports').textContent = exactNumber.format(totals.lmCacheReportedRequests);
  $('#lm-cache-donut').style.background = `conic-gradient(var(--cyan) ${(lmRate || 0) * 360}deg, var(--surface-3) 0)`;
  $('#lm-cache-note').textContent = lmRate === null
    ? 'El proveedor no ha enviado cached_tokens en este periodo; no equivale a un 0 % de reutilización'
    : `${exactNumber.format(totals.lmCachedInputTokens)} de ${exactNumber.format(totals.lmReportedInputTokens)} tokens de entrada fueron reutilizados por el motor`;
  if (pageName === 'dashboard') {
    renderTimeline(timeline);
    renderKeyBars(byKey);
  }
  renderActivity(recent);
}

function renderLive() {
  const live = state.live || { activeStreams: 0, tokensPerSecond: 0, streams: [] };
  $('#live-count').textContent = exactNumber.format(live.activeStreams);
  $('#live-tps').textContent = exactNumber.format(live.tokensPerSecond);
  $('#live-state').classList.toggle('active', live.activeStreams > 0);
  const container = $('#live-streams');
  if (!live.streams.length) {
    container.innerHTML = '<div class="live-empty"><span></span>Ningún modelo está emitiendo tokens ahora</div>';
    return;
  }
  container.innerHTML = live.streams.map((item) => `<div class="live-stream-row">
    <span class="emission-indicator ${item.status}"><i></i>${item.status === 'emitting' ? 'Emitiendo' : 'Esperando'}</span>
    <div class="live-identity"><strong>${escapeHtml(item.keyName || 'Clave eliminada')}</strong><small>${escapeHtml(item.model || item.path)}</small></div>
    <div class="live-output"><strong>≈ ${exactNumber.format(item.outputTokensApprox)}</strong><small>tokens de salida</small></div>
    <div class="live-rate"><strong>${exactNumber.format(item.tokensPerSecond)}</strong><small>tok/s aprox.</small></div>
    <span class="live-elapsed">${Math.max(1, Math.round(item.elapsedMs / 1000))} s</span>
  </div>`).join('');
}

function renderTimeline(points) {
  const canvas = $('#token-chart');
  const parent = canvas.parentElement;
  const rect = parent.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const width = rect.width, height = rect.height;
  const pad = { left: 48, right: 13, top: 18, bottom: 34 };
  const chartW = width - pad.left - pad.right, chartH = height - pad.top - pad.bottom;
  ctx.clearRect(0, 0, width, height);
  $('#token-empty').classList.toggle('hidden', points.length > 0);
  chartModel = null;
  $('#chart-tooltip').classList.add('hidden');
  if (!points.length) return;
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.inputTokens, point.outputTokens]));
  ctx.font = '10px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + chartH * index / 4;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#8b8b8b'; ctx.textAlign = 'left'; ctx.fillText(compactNumber.format(maxValue * (1 - index / 4)), 3, y + 3);
  }
  const xFor = (index) => pad.left + (points.length === 1 ? chartW / 2 : chartW * index / (points.length - 1));
  const yFor = (value) => pad.top + chartH - value / maxValue * chartH;
  chartModel = { points, xFor, yFor, width, height };
  const drawLine = (key, color, fill) => {
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(xFor(index), yFor(point[key])) : ctx.moveTo(xFor(index), yFor(point[key])));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(xFor(points.length - 1), pad.top + chartH); ctx.lineTo(xFor(0), pad.top + chartH); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  drawLine('inputTokens', '#59dcb5', 'rgba(89,220,181,.10)');
  drawLine('outputTokens', '#79d9ff', 'rgba(121,217,255,.07)');
  const labelCount = Math.min(5, points.length);
  for (let index = 0; index < labelCount; index += 1) {
    const pointIndex = Math.round(index * (points.length - 1) / Math.max(1, labelCount - 1));
    const date = new Date(points[pointIndex].at);
    const label = Number($('#range-filter').value) > 72
      ? date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
      : date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    ctx.fillStyle = '#8b8b8b'; ctx.textAlign = index === 0 ? 'left' : index === labelCount - 1 ? 'right' : 'center'; ctx.fillText(label, xFor(pointIndex), height - 9);
  }
}

function hideChartTooltip() {
  $('#chart-tooltip').classList.add('hidden');
}

function showChartTooltip(event) {
  if (!chartModel) return hideChartTooltip();
  const canvas = $('#token-chart');
  const rect = canvas.parentElement.getBoundingClientRect();
  const x = Math.max(0, Math.min(chartModel.width, event.clientX - rect.left));
  const pointIndex = chartModel.points.reduce((closest, point, index) => Math.abs(chartModel.xFor(index) - x) < Math.abs(chartModel.xFor(closest) - x) ? index : closest, 0);
  const point = chartModel.points[pointIndex];
  const tooltip = $('#chart-tooltip');
  const date = new Date(point.at).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  tooltip.innerHTML = `<strong>${date}</strong><div class="tooltip-input"><span>Tokens de entrada</span><b>${exactNumber.format(point.inputTokens)}</b></div><div class="tooltip-output"><span>Tokens de salida</span><b>${exactNumber.format(point.outputTokens)}</b></div>`;
  tooltip.style.left = `${chartModel.xFor(pointIndex)}px`;
  tooltip.style.top = `${Math.max(12, chartModel.yFor(Math.max(point.inputTokens, point.outputTokens)) - 10)}px`;
  tooltip.classList.remove('hidden');
}

function renderKeyBars(items) {
  const container = $('#key-bars');
  if (!items.length) { container.innerHTML = '<div class="empty-state">No hay datos de consumo todavía</div>'; return; }
  const max = Math.max(...items.map((item) => item.inputTokens + item.outputTokens), 1);
  container.innerHTML = items.slice(0, 12).map((item) => `<div class="key-bar-row"><span class="key-bar-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><div class="bar-track" title="Entrada ${exactNumber.format(item.inputTokens)} · Salida ${exactNumber.format(item.outputTokens)}"><span class="bar-input" style="width:${item.inputTokens / max * 100}%"></span><span class="bar-output" style="width:${item.outputTokens / max * 100}%"></span></div><span class="key-bar-value">${compactNumber.format(item.inputTokens + item.outputTokens)}</span></div>`).join('');
}

function renderKeys() {
  $('#active-key-count').textContent = exactNumber.format(state.keys.filter((key) => !key.revokedAt && !key.pausedAt).length);
  $('#paused-key-count').textContent = exactNumber.format(state.keys.filter((key) => !key.revokedAt && key.pausedAt).length);
  const table = $('#keys-table');
  if (!state.keys.length) { table.innerHTML = '<tr><td colspan="6" class="empty-cell">No hay claves. Usa “Crear nueva clave” para añadir la primera.</td></tr>'; return; }
  table.innerHTML = [...state.keys].reverse().map((key) => {
    const stateLabel = key.revokedAt ? 'Revocada' : key.pausedAt ? 'Pausada' : 'Activa';
    const stateClass = key.revokedAt ? 'revoked' : key.pausedAt ? 'paused' : '';
    const accessAction = key.pausedAt
      ? `<button class="row-action resume-key" data-id="${escapeHtml(key.id)}" type="button">Reanudar</button><button class="row-action edit-pause-message" data-id="${escapeHtml(key.id)}" type="button">Editar aviso</button>`
      : `<button class="row-action pause-key" data-id="${escapeHtml(key.id)}" type="button">Pausar</button>`;
    const actions = key.revokedAt ? '' : `<div class="row-actions">${accessAction}<button class="row-action revoke-key" data-id="${escapeHtml(key.id)}" data-name="${escapeHtml(key.name)}" type="button">Revocar</button></div>`;
    return `<tr><td><strong>${escapeHtml(key.name)}</strong></td><td><code>${escapeHtml(key.prefix)}••••</code></td><td>${dateTime.format(new Date(key.createdAt))}</td><td>${key.lastUsedAt ? dateTime.format(new Date(key.lastUsedAt)) : 'Nunca'}</td><td><span class="state-pill ${stateClass}">${stateLabel}</span></td><td>${actions}</td></tr>`;
  }).join('');
  table.querySelectorAll('.pause-key').forEach((button) => button.addEventListener('click', () => openPauseDialog(button.dataset.id, false)));
  table.querySelectorAll('.edit-pause-message').forEach((button) => button.addEventListener('click', () => openPauseDialog(button.dataset.id, true)));
  table.querySelectorAll('.resume-key').forEach((button) => button.addEventListener('click', () => resumeKey(button.dataset.id)));
  table.querySelectorAll('.revoke-key').forEach((button) => button.addEventListener('click', () => revokeKey(button.dataset.id, button.dataset.name)));
}

function renderActivity(items = []) {
  const keys = new Map(state.keys.map((key) => [key.id, key.name]));
  const container = $('#activity-list');
  if (!items.length) { container.innerHTML = '<div class="empty-state">No hay solicitudes registradas en este periodo</div>'; return; }
  container.innerHTML = items.map((item) => {
    const hasLmCache = Number.isFinite(item.lmCachedInputTokens);
    const lmCacheRate = hasLmCache && item.inputTokens > 0 ? item.lmCachedInputTokens / item.inputTokens : null;
    const unsupportedChatCache = !hasLmCache && item.path === '/v1/chat/completions';
    const cacheLabel = hasLmCache ? `${Math.round((lmCacheRate || 0) * 100)}% · ${compactNumber.format(item.lmCachedInputTokens)}` : unsupportedChatCache ? 'No disponible' : 'No reportado';
    const cacheClass = !hasLmCache ? 'unavailable' : item.lmCachedInputTokens > 0 ? 'reused' : 'processed';
    const cacheTitle = hasLmCache
      ? `${exactNumber.format(item.lmCachedInputTokens)} de ${exactNumber.format(item.inputTokens)} tokens de entrada reutilizados`
      : unsupportedChatCache
        ? 'LM Studio no ha incluido cached_tokens en esta respuesta de Chat Completions'
        : 'El proveedor no incluyó cached_tokens en esta respuesta';
    const throughput = Number.isFinite(item.tokensPerSecond) ? `<small>${exactNumber.format(item.tokensPerSecond)} tok/s${item.throughputSource === 'estimated' ? ' ≈' : ''}</small>` : '';
    return `<div class="activity-row"><span class="activity-time">${timeOnly.format(new Date(item.at))}</span><span class="activity-name">${escapeHtml(keys.get(item.keyId) || 'Clave eliminada')}</span><span class="activity-path">${escapeHtml(item.path)}${item.model ? ` · ${escapeHtml(item.model)}` : ''}</span><span class="activity-tokens">↓${compactNumber.format(item.inputTokens)} ↑${compactNumber.format(item.outputTokens)}</span><span class="cache-tag ${cacheClass}" title="${escapeHtml(cacheTitle)}">${cacheLabel}</span><span class="activity-latency">${exactNumber.format(item.latencyMs)} ms${throughput}</span><span class="http-status ${item.status >= 400 ? 'error' : ''}">${item.status}</span></div>`;
  }).join('');
}

function renderSettings() {
  const settings = state.settings;
  $('#upstream-url').value = settings.upstreamBaseUrl;
  $('#upstream-key').placeholder = settings.hasUpstreamApiKey ? 'Configurada · vacío para conservar' : 'Sin autenticación';
  $('#public-gateway-url').value = settings.publicGatewayUrl;
  updateEndpointPreview();
  $('#gateway-port').textContent = settings.gatewayPort;
  $('#admin-port').textContent = settings.adminPort;
  $('#storage-settings').textContent = settings.storage
    ? `${settings.storage.engine} ${settings.storage.journalMode} · ${compactNumber.format(settings.storage.metrics)} métricas`
    : 'No disponible';
  $('#retention-settings').textContent = `${settings.retentionDays} días`;
  $('#tunnel-origin').textContent = `http://localhost:${settings.gatewayPort}`;
}

function updateEndpointPreview() {
  const base = ($('#public-gateway-url').value || state.settings?.publicGatewayUrl || '').replace(/\/+$/, '');
  $('#gateway-url').textContent = `${base}/v1`;
}

async function checkUpstream() {
  const dot = $('#rail-status-dot');
  const label = $('#rail-status');
  const pill = $('#settings-upstream-status');
  dot.className = 'status-dot pending'; label.textContent = 'Comprobando'; pill.className = 'connection-pill'; pill.innerHTML = '<i></i> comprobando';
  try {
    const status = await api('/admin/api/upstream/status');
    dot.className = `status-dot ${status.online ? 'online' : 'offline'}`;
    label.textContent = status.online ? `Online · ${status.latencyMs} ms` : `HTTP ${status.status}`;
    pill.className = `connection-pill ${status.online ? 'online' : 'offline'}`;
    pill.innerHTML = `<i></i> ${status.online ? `online · ${status.latencyMs} ms` : 'sin conexión'}`;
    return status;
  } catch {
    dot.className = 'status-dot offline'; label.textContent = 'Desconectado'; pill.className = 'connection-pill offline'; pill.innerHTML = '<i></i> sin conexión';
    return null;
  }
}

async function revokeKey(id, name) {
  if (!confirm(`¿Revocar definitivamente la clave “${name}”? No podrá volver a activarse.`)) return;
  try { await api(`/admin/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Clave revocada'); await loadAll(); } catch (error) { toast(error.message); }
}

function openPauseDialog(id, editing) {
  const key = state.keys.find((item) => item.id === id);
  if (!key || key.revokedAt) return;
  $('#pause-form').dataset.id = id;
  $('#pause-form').dataset.editing = editing ? 'true' : 'false';
  $('#pause-dialog-title').textContent = editing ? `Aviso para ${key.name}` : `Pausar ${key.name}`;
  $('#pause-dialog-copy').textContent = editing
    ? 'Actualiza la respuesta que verá este usuario mientras su token permanezca pausado.'
    : 'Las inferencias no llegarán al modelo. En su lugar, el usuario recibirá este mensaje como respuesta del asistente.';
  $('#pause-message').value = key.pausedMessage || DEFAULT_PAUSED_MESSAGE;
  $('#pause-message-error').textContent = '';
  $('#pause-submit').textContent = editing ? 'Guardar aviso' : 'Pausar clave';
  updatePauseMessageCount();
  $('#pause-dialog').showModal();
  setTimeout(() => $('#pause-message').focus(), 50);
}

function updatePauseMessageCount() {
  $('#pause-message-count').textContent = `${$('#pause-message').value.length} / 500`;
}

async function resumeKey(id) {
  try {
    await api(`/admin/api/keys/${encodeURIComponent(id)}/access`, { method: 'PATCH', body: JSON.stringify({ paused: false }) });
    toast('Clave reanudada');
    await loadAll();
  } catch (error) { toast(error.message); }
}

function updateClock() { $('#header-clock').textContent = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()); }

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#auth-message');
  state.token = $('#admin-token').value;
  message.textContent = 'Verificando…'; message.classList.remove('error');
  try { await api('/admin/api/session'); localStorage.setItem(ADMIN_TOKEN_KEY, state.token); hideAuth(); message.textContent = ''; await loadAll(); }
  catch (error) { message.textContent = error.message; message.classList.add('error'); }
});

$('#logout-button').addEventListener('click', () => { localStorage.removeItem(ADMIN_TOKEN_KEY); sessionStorage.removeItem(ADMIN_TOKEN_KEY); state.token = ''; $('#admin-token').value = ''; showAuth(); });
$('#range-filter').addEventListener('change', () => pageName === 'dashboard' && refreshOverview());
$('#from-date').addEventListener('change', () => pageName === 'dashboard' && refreshOverview());
$('#to-date').addEventListener('change', () => pageName === 'dashboard' && refreshOverview());
$('#clear-date-filter').addEventListener('click', () => { $('#from-date').value = ''; $('#to-date').value = ''; if (pageName === 'dashboard') refreshOverview(); });
$('#key-filter').addEventListener('change', () => {
  if (pageName !== 'dashboard') return;
  refreshOverview();
  refreshLive();
});
$('#activity-range').addEventListener('change', () => pageName === 'activity' && refreshOverview());
$('#activity-key-filter').addEventListener('change', () => pageName === 'activity' && refreshOverview());
$('#activity-from-date').addEventListener('change', () => pageName === 'activity' && refreshOverview());
$('#activity-to-date').addEventListener('change', () => pageName === 'activity' && refreshOverview());
$('#activity-clear-date-filter').addEventListener('click', () => {
  $('#activity-from-date').value = '';
  $('#activity-to-date').value = '';
  if (pageName === 'activity') refreshOverview();
});
$$('[data-open-key-dialog]').forEach((button) => button.addEventListener('click', () => { $('#key-form').reset(); $('#key-message').textContent = ''; $('#key-dialog').showModal(); setTimeout(() => $('#key-name').focus(), 50); }));
$('#key-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  try { const payload = await api('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: $('#key-name').value }) }); $('#key-dialog').close(); $('#created-token').textContent = payload.key.token; $('#token-dialog').showModal(); await loadAll(); }
  catch (error) { $('#key-message').textContent = error.message; }
});
$('#pause-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const form = event.currentTarget;
  const editing = form.dataset.editing === 'true';
  const message = $('#pause-message-error');
  message.textContent = editing ? 'Guardando aviso…' : 'Pausando clave…';
  message.classList.remove('error');
  try {
    await api(`/admin/api/keys/${encodeURIComponent(form.dataset.id)}/access`, {
      method: 'PATCH',
      body: JSON.stringify({ paused: true, pausedMessage: $('#pause-message').value })
    });
    $('#pause-dialog').close();
    toast(editing ? 'Aviso actualizado' : 'Clave pausada');
    await loadAll();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add('error');
  }
});
$('#pause-message').addEventListener('input', updatePauseMessageCount);
$('#pause-default').addEventListener('click', () => { $('#pause-message').value = DEFAULT_PAUSED_MESSAGE; updatePauseMessageCount(); $('#pause-message').focus(); });
$('#copy-token').addEventListener('click', async () => { await navigator.clipboard.writeText($('#created-token').textContent); toast('Token copiado'); });
$('#close-token-dialog').addEventListener('click', () => $('#token-dialog').close());
$('#token-saved').addEventListener('click', () => $('#token-dialog').close());
$('#copy-endpoint').addEventListener('click', async () => { await navigator.clipboard.writeText($('#gateway-url').textContent); toast('Endpoint copiado'); });
$('#public-gateway-url').addEventListener('input', updateEndpointPreview);
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#settings-message'); message.className = 'form-message'; message.textContent = 'Guardando cambios…';
  try {
    const upstreamApiKey = $('#upstream-key').value;
    await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ upstreamBaseUrl: $('#upstream-url').value, publicGatewayUrl: $('#public-gateway-url').value, ...(upstreamApiKey ? { upstreamApiKey } : {}) }) });
    $('#upstream-key').value = ''; message.textContent = 'Configuración guardada correctamente.'; await loadAll();
  } catch (error) { message.textContent = error.message; message.classList.add('error'); }
});
$('#test-upstream').addEventListener('click', async () => { const status = await checkUpstream(); toast(status?.online ? `Proveedor IA Local responde en ${status.latencyMs} ms · ${status.models.length} modelo(s)` : 'No se puede contactar con Proveedor IA Local'); });
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#token-chart').addEventListener('mousemove', showChartTooltip);
$('#token-chart').addEventListener('mouseleave', hideChartTooltip);

window.addEventListener('resize', () => { clearTimeout(window.chartResize); window.chartResize = setTimeout(() => pageName === 'dashboard' && state.overview && renderTimeline(state.overview.timeline), 120); });
initializeRoute(); updateClock(); setInterval(updateClock, 1000);
api('/admin/api/session')
  .then(() => { hideAuth(); revealApp(); loadAll().catch((error) => toast(error.message)); })
  .catch(() => { showAuth(); revealApp(); });
setInterval(() => { if (state.token && document.visibilityState === 'visible' && (pageName === 'dashboard' || pageName === 'activity')) refreshOverview().catch(() => {}); }, 15000);
setInterval(() => { if (state.token && document.visibilityState === 'visible' && pageName === 'dashboard') refreshLive().catch(() => {}); }, 1000);

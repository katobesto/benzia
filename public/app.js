const routes = {
  '/': 'dashboard',
  '/dashboard': 'dashboard',
  '/keys': 'keys',
  '/activity': 'activity',
  '/utilities': 'utilities',
  '/server': 'server',
  '/settings': 'settings'
};

const ADMIN_TOKEN_KEY = 'benzIA_admin_token';
const DEFAULT_PAUSED_MESSAGE = 'Su token ha sido deshabilitado por el administrador. Consulte con Benzo para evaluar si se trata de un problema de pago o personal.';
const legacyAdminToken = sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
const rememberedAdminToken = localStorage.getItem(ADMIN_TOKEN_KEY) || legacyAdminToken;
if (legacyAdminToken && !localStorage.getItem(ADMIN_TOKEN_KEY)) localStorage.setItem(ADMIN_TOKEN_KEY, legacyAdminToken);
sessionStorage.removeItem(ADMIN_TOKEN_KEY);
const pageName = routes[window.location.pathname.replace(/\/$/, '') || '/'] || 'dashboard';
const state = { token: rememberedAdminToken, keys: [], overview: null, live: null, settings: null, utility: { providers: [], agents: [] } };
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
    credentials: 'same-origin',
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
  if (pageName === 'server') {
    await api('/admin/api/server-session', { method: 'POST', body: '{}' });
    const frame = $('#server-frame');
    if (frame && frame.dataset.src) frame.src = frame.dataset.src;
  }
  renderKeyFilter();
  renderKeys();
  renderSettings();
  renderOpenCodeUtility();
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
    <span class="emission-indicator ${item.status}"><i></i>${item.status === 'emitting' ? 'Emitiendo' : 'Prefill'}</span>
    <div class="live-identity"><strong>${escapeHtml(item.keyName || 'Clave eliminada')}</strong><small>${escapeHtml(item.model || item.path)}</small></div>
    <div class="live-output"><strong>≈ ${exactNumber.format(item.outputTokensApprox)}</strong><small>tokens de salida</small></div>
    <div class="live-rate"><strong>${item.status === 'emitting' || item.prefillTokensPerSecond !== null ? exactNumber.format(item.status === 'emitting' ? item.tokensPerSecond : item.prefillTokensPerSecond) : '—'}</strong><small>${item.status === 'emitting' ? 'tok/s aprox.' : 'tok/s prefill'}</small></div>
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
  container.innerHTML = items.slice(0, 12).map((item) => {
    const input = Math.max(0, Number(item.inputTokens) || 0);
    const output = Math.max(0, Number(item.outputTokens) || 0);
    return `<div class="key-bar-row"><span class="key-bar-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><svg class="bar-track" viewBox="0 0 ${max} 8" preserveAspectRatio="none" role="img" aria-label="Entrada ${exactNumber.format(input)} · Salida ${exactNumber.format(output)}"><rect class="bar-input" x="0" y="0" width="${input}" height="8"></rect><rect class="bar-output" x="${input}" y="0" width="${output}" height="8"></rect></svg><span class="key-bar-value">${compactNumber.format(input + output)}</span></div>`;
  }).join('');
}

function renderKeys() {
  $('#active-key-count').textContent = exactNumber.format(state.keys.filter((key) => !key.revokedAt && !key.pausedAt).length);
  $('#paused-key-count').textContent = exactNumber.format(state.keys.filter((key) => !key.revokedAt && key.pausedAt).length);
  const table = $('#keys-table');
  if (!state.keys.length) { table.innerHTML = '<tr><td colspan="7" class="empty-cell">No hay claves. Usa “Crear nueva clave” para añadir la primera.</td></tr>'; return; }
  table.innerHTML = [...state.keys].reverse().map((key) => {
    const stateLabel = key.revokedAt ? 'Revocada' : key.pausedAt ? 'Pausada' : 'Activa';
    const stateClass = key.revokedAt ? 'revoked' : key.pausedAt ? 'paused' : '';
    const accessAction = key.pausedAt
      ? `<button class="row-action resume-key" data-id="${escapeHtml(key.id)}" type="button">Reanudar</button><button class="row-action edit-pause-message" data-id="${escapeHtml(key.id)}" type="button">Editar aviso</button>`
      : `<button class="row-action pause-key" data-id="${escapeHtml(key.id)}" type="button">Pausar</button>`;
    const actions = key.revokedAt ? '' : `<div class="row-actions">${accessAction}<button class="row-action revoke-key" data-id="${escapeHtml(key.id)}" data-name="${escapeHtml(key.name)}" type="button">Revocar</button></div>`;
    const providerAccess = `<select class="key-provider-access" data-id="${escapeHtml(key.id)}" aria-label="Acceso a proveedores de ${escapeHtml(key.name)}" ${key.revokedAt ? 'disabled' : ''}><option value="local" ${!key.allowExternalProviders ? 'selected' : ''}>Solo proveedor local</option><option value="external" ${key.allowExternalProviders ? 'selected' : ''}>Permitir externos</option></select>`;
    return `<tr><td><strong>${escapeHtml(key.name)}</strong></td><td><code>${escapeHtml(key.prefix)}••••</code></td><td>${dateTime.format(new Date(key.createdAt))}</td><td>${key.lastUsedAt ? dateTime.format(new Date(key.lastUsedAt)) : 'Nunca'}</td><td>${providerAccess}</td><td><span class="state-pill ${stateClass}">${stateLabel}</span></td><td>${actions}</td></tr>`;
  }).join('');
  table.querySelectorAll('.pause-key').forEach((button) => button.addEventListener('click', () => openPauseDialog(button.dataset.id, false)));
  table.querySelectorAll('.edit-pause-message').forEach((button) => button.addEventListener('click', () => openPauseDialog(button.dataset.id, true)));
  table.querySelectorAll('.resume-key').forEach((button) => button.addEventListener('click', () => resumeKey(button.dataset.id)));
  table.querySelectorAll('.revoke-key').forEach((button) => button.addEventListener('click', () => revokeKey(button.dataset.id, button.dataset.name)));
  table.querySelectorAll('.key-provider-access').forEach((select) => select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await api(`/admin/api/keys/${encodeURIComponent(select.dataset.id)}/providers`, { method: 'PATCH', body: JSON.stringify({ allowExternalProviders: select.value === 'external' }) });
      toast(select.value === 'external' ? 'Proveedores externos habilitados' : 'Acceso limitado al proveedor local');
      await loadAll();
    } catch (error) { toast(error.message); select.disabled = false; }
  }));
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
  $('#brave-search-endpoint').value = settings.braveSearchEndpoint;
  $('#brave-search-key').placeholder = settings.hasBraveSearchApiKey ? 'Configurada · vacío para conservar' : 'Sin configurar';
  const braveStatus = $('#brave-search-status');
  braveStatus.className = `connection-pill ${settings.hasBraveSearchApiKey ? 'online' : ''}`;
  braveStatus.innerHTML = `<i></i> ${settings.hasBraveSearchApiKey ? 'listo para chat' : 'sin configurar'}`;
  updateEndpointPreview();
  $('#gateway-port').textContent = settings.gatewayPort;
  $('#admin-port').textContent = settings.adminPort;
  $('#storage-settings').textContent = settings.storage
    ? `${settings.storage.engine} ${settings.storage.journalMode} · ${compactNumber.format(settings.storage.metrics)} métricas`
    : 'No disponible';
  $('#retention-settings').textContent = `${settings.retentionDays} días`;
  $('#tunnel-origin').textContent = `http://localhost:${settings.gatewayPort}`;
  settings.externalProviders = (settings.externalProviders || []).map((provider) => ({ ...provider, originalId: provider.id, apiKey: provider.apiKey || '', status: provider.status || null }));
  renderExternalProviders();
}

function createExternalProvider() {
  const number = (state.settings.externalProviders?.length || 0) + 1;
  return { id: `externo-${number}`, originalId: '', name: `Proveedor externo ${number}`, baseUrl: '', apiKey: '', hasApiKey: false, status: null };
}

function renderExternalProviders() {
  const container = $('#external-providers');
  const providers = state.settings?.externalProviders || [];
  if (!providers.length) {
    container.innerHTML = '<div class="external-provider-empty">No hay proveedores externos configurados. El proveedor local seguirá funcionando con normalidad.</div>';
    return;
  }
  container.innerHTML = providers.map((provider, index) => {
    const status = provider.status ? `<span class="utility-status ${provider.status.online ? 'online' : 'offline'}">${escapeHtml(provider.status.message)}</span>` : '';
    return `<article class="external-provider" data-provider-index="${index}">
      <div class="external-provider-head"><div><span class="provider-sequence">EXT ${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(provider.name || `Proveedor ${index + 1}`)}</strong></div><div>${status}<button class="row-action remove-external-provider" type="button">Eliminar</button></div></div>
      <div class="form-grid external-provider-grid">
        <label><span class="external-field-title">Nombre visible</span><input data-external-field="name" value="${escapeHtml(provider.name)}" maxlength="80" required placeholder="OpenAI"></label>
        <label><span class="external-field-title">ID / prefijo</span><input data-external-field="id" value="${escapeHtml(provider.id)}" maxlength="50" pattern="[a-z0-9][a-z0-9_-]*" required placeholder="openai"><small>Los modelos se publican como <code>${escapeHtml(provider.id || 'proveedor')}/modelo</code>.</small></label>
        <label><span class="external-field-title">URL OpenAI-compatible</span><input data-external-field="baseUrl" type="url" value="${escapeHtml(provider.baseUrl)}" required placeholder="https://api.openai.com"><small>Acepta la URL base con o sin <code>/v1</code>.</small></label>
        <label><span class="external-field-title">Token del proveedor <span class="optional">Opcional</span></span><input data-external-field="apiKey" type="password" value="" autocomplete="new-password" placeholder="${provider.hasApiKey ? 'Configurado · vacío para conservar' : 'Sin autenticación'}"><small>Se guarda sólo en el servidor.</small></label>
      </div>
      <div class="external-provider-tools"><button class="secondary-button test-external-provider" type="button">Probar y consultar modelos</button><span>benzIA consultará <code>GET /v1/models</code> dinámicamente</span></div>
    </article>`;
  }).join('');
}

function updateEndpointPreview() {
  const base = ($('#public-gateway-url').value || state.settings?.publicGatewayUrl || '').replace(/\/+$/, '');
  $('#gateway-url').textContent = `${base}/v1`;
}

function utilityId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createOpenCodeProvider() {
  const gateway = normalizeUtilityBaseUrl(state.settings?.publicGatewayUrl || '');
  return {
    id: utilityId('provider'), name: 'benzIA', identifier: 'benzia',
    baseUrl: gateway || '', apiKey: '', models: [], status: null
  };
}

function createOpenCodeModel(initial = {}) {
  return {
    id: utilityId('model'), modelId: initial.modelId || '', name: initial.name || initial.modelId || '',
    context: 32768, output: 8192, image: false, tools: true, role: 'small',
    reasoningEffort: '', preserveThinking: false
  };
}

function createOpenCodeAgent() {
  return {
    id: utilityId('agent'), agentId: 'auxiliar', description: '', modelRef: '', mode: 'subagent',
    permissions: { read: 'allow', grep: 'allow', shell: 'ask', edit: 'deny', websearch: 'allow', subagent: 'allow' }
  };
}

function normalizeUtilityBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname || ''}/v1`;
    return url.toString().replace(/\/+$/, '');
  } catch { return null; }
}

function configIdentifier(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized && !/^\d/.test(normalized) ? normalized : fallback;
}

function uniqueConfigKey(base, taken) {
  let candidate = base || 'model';
  let number = 2;
  while (taken.has(candidate)) candidate = `${base}-${number++}`;
  taken.add(candidate);
  return candidate;
}

function utilityModelOptions() {
  return state.utility.providers.flatMap((provider) => provider.models
    .filter((model) => model.modelId.trim())
    .map((model) => ({ ref: `${provider.id}:${model.id}`, label: `${provider.name || 'Servidor'} · ${model.name || model.modelId}` })));
}

function buildOpenCodeConfig() {
  const provider = {};
  const references = new Map();
  const providerNames = new Set();
  let mainModel = '';
  let smallModel = '';
  let hasSecret = false;
  const errors = [];
  state.utility.providers.forEach((provider, providerIndex) => {
    const baseUrl = normalizeUtilityBaseUrl(provider.baseUrl);
    const usableModels = provider.models.filter((model) => model.modelId.trim());
    if (!provider.name.trim() && !baseUrl && !usableModels.length) return;
    if (!baseUrl) errors.push(`El servidor “${provider.name || providerIndex + 1}” necesita una URL /v1 válida.`);
    if (!usableModels.length) errors.push(`Añade al menos un modelo para “${provider.name || providerIndex + 1}”.`);
    const providerKey = uniqueConfigKey(configIdentifier(provider.identifier, `provider-${providerIndex + 1}`), providerNames);
    const settings = { baseURL: baseUrl || '' };
    if (provider.apiKey) { settings.apiKey = provider.apiKey; hasSecret = true; }
    const models = {};
    const modelNames = new Set();
    usableModels.forEach((model, modelIndex) => {
      const modelKey = uniqueConfigKey(model.modelId.trim() || `model-${modelIndex + 1}`, modelNames);
      const limit = {
        context: Math.max(1, Number.parseInt(model.context, 10) || 32768),
        output: Math.max(1, Number.parseInt(model.output, 10) || 8192)
      };
      const options = {};
      if (model.reasoningEffort) options.reasoningEffort = model.reasoningEffort;
      models[modelKey] = {
        name: model.name.trim() || model.modelId.trim(),
        tool_call: Boolean(model.tools),
        ...(model.reasoningEffort || model.preserveThinking ? { reasoning: true } : {}),
        modalities: { input: model.image ? ['text', 'image'] : ['text'], output: ['text'] },
        limit,
        ...(Object.keys(options).length ? { options } : {})
      };
      const ref = `${provider.id}:${model.id}`;
      references.set(ref, `${providerKey}/${modelKey}`);
      if (model.role === 'main' && !mainModel) mainModel = `${providerKey}/${modelKey}`;
      if (model.role === 'small' && !smallModel) smallModel = `${providerKey}/${modelKey}`;
    });
    provider[providerKey] = {
      name: provider.name.trim() || providerKey,
      npm: '@ai-sdk/openai-compatible',
      options: settings,
      models
    };
  });
  const agents = {};
  const agentNames = new Set();
  state.utility.agents.forEach((agent, index) => {
    const model = references.get(agent.modelRef);
    if (!agent.agentId.trim() && !agent.description.trim() && !agent.modelRef) return;
    if (!agent.agentId.trim()) errors.push(`El subagente ${index + 1} necesita un identificador.`);
    if (!model) errors.push(`El subagente “${agent.agentId || index + 1}” necesita un modelo válido.`);
    const agentKey = uniqueConfigKey(configIdentifier(agent.agentId, `subagent-${index + 1}`), agentNames);
    const permission = Object.entries(agent.permissions)
      .filter(([, effect]) => effect)
      .reduce((result, [action, effect]) => ({ ...result, [action === 'shell' ? 'bash' : action === 'subagent' ? 'task' : action]: effect }), {});
    agents[agentKey] = {
      ...(agent.description.trim() ? { description: agent.description.trim() } : {}),
      mode: agent.mode === 'primary' ? 'primary' : 'subagent',
      ...(model ? { model } : {}),
      ...(Object.keys(permission).length ? { permission } : {})
    };
  });
  if (!Object.keys(provider).length) errors.push('Añade un servidor y, como mínimo, un modelo.');
  if (!mainModel && Object.keys(provider).length) errors.push('Marca un modelo como principal.');
  return {
    config: {
      $schema: 'https://opencode.ai/config.json',
      ...(mainModel ? { model: mainModel } : {}),
      ...(smallModel ? { small_model: smallModel } : {}),
      provider,
      ...(Object.keys(agents).length ? { agent: agents } : {})
    },
    errors,
    hasSecret
  };
}

function renderOpenCodeUtility() {
  if (!state.utility.providers.length) state.utility.providers.push(createOpenCodeProvider());
  const providers = $('#opencode-providers');
  providers.innerHTML = state.utility.providers.map((provider, index) => {
    const status = provider.status ? `<span class="utility-status ${provider.status.online ? 'online' : 'offline'}">${escapeHtml(provider.status.message)}</span>` : '';
    return `<article class="panel opencode-provider" data-provider-id="${provider.id}">
      <div class="panel-header"><div><h2>${escapeHtml(provider.name || `Servidor ${index + 1}`)}</h2><p>Proveedor OpenAI-compatible independiente</p></div><div class="provider-actions">${status}<button class="row-action remove-opencode-provider" type="button">Eliminar</button></div></div>
      <div class="form-grid opencode-provider-fields">
        <label>Nombre visible<input data-provider-field="name" value="${escapeHtml(provider.name)}" maxlength="80" placeholder="benzIA"></label>
        <label>ID del proveedor<input data-provider-field="identifier" value="${escapeHtml(provider.identifier)}" maxlength="50" pattern="[A-Za-z0-9_-]+" placeholder="benzia"><small>Se usa en <code>provider/model</code>.</small></label>
        <label class="wide-field">URL base<input data-provider-field="baseUrl" type="url" value="${escapeHtml(provider.baseUrl)}" autocomplete="url" placeholder="https://benzia.tudominio.com/v1" required><small>Se normaliza a <code>/v1</code> al comprobar y generar.</small></label>
        <label>Token de acceso <span class="optional">Opcional</span><span class="secret-input"><input data-provider-field="apiKey" type="password" value="${escapeHtml(provider.apiKey)}" autocomplete="off" placeholder="lmg_…"><button class="toggle-utility-secret" type="button" aria-label="Mostrar token">Mostrar</button></span><small>No se guarda en benzIA.</small></label>
      </div>
      <div class="provider-tools"><button class="secondary-button test-opencode-provider" type="button">Probar conexión</button><button class="secondary-button discover-opencode-models" type="button">Detectar modelos</button><span>Consulta estándar <code>GET /v1/models</code></span></div>
      <div class="models-heading"><div><h3>Modelos</h3><p>Configura capacidades y límites antes de generar.</p></div><button class="secondary-button add-opencode-model" type="button">＋ Añadir modelo</button></div>
      <div class="opencode-models">${provider.models.length ? provider.models.map((model, modelIndex) => renderOpenCodeModel(model, modelIndex)).join('') : '<div class="utility-empty">Aún no hay modelos. Detecta los disponibles o añade uno manualmente.</div>'}</div>
    </article>`;
  }).join('');
  const modelOptions = utilityModelOptions();
  $('#opencode-agents').innerHTML = state.utility.agents.length ? state.utility.agents.map((agent, index) => renderOpenCodeAgent(agent, index, modelOptions)).join('') : '<div class="utility-empty">Sin subagentes. Puedes añadirlos para tareas auxiliares o modelos pequeños.</div>';
  const generated = buildOpenCodeConfig();
  $('#opencode-json').textContent = JSON.stringify(generated.config, null, 2);
  $('#opencode-secret-warning').classList.toggle('hidden', !generated.hasSecret);
  $('#opencode-json-state').className = `connection-pill ${generated.errors.length ? 'offline' : 'online'}`;
  $('#opencode-json-state').innerHTML = `<i></i> ${generated.errors.length ? `${generated.errors.length} pendiente${generated.errors.length > 1 ? 's' : ''}` : 'listo'}`;
}

function renderOpenCodeModel(model, index) {
  return `<article class="opencode-model" data-model-id="${model.id}">
    <div class="model-title"><strong>Modelo ${index + 1}</strong><button class="row-action remove-opencode-model" type="button">Eliminar</button></div>
    <div class="model-grid">
      <label>ID real del modelo<input data-model-field="modelId" value="${escapeHtml(model.modelId)}" maxlength="180" placeholder="qwen3-8b-instruct"><small>El identificador enviado al servidor.</small></label>
      <label>Nombre visible<input data-model-field="name" value="${escapeHtml(model.name)}" maxlength="120" placeholder="Qwen 3 8B"></label>
      <label>Contexto<input data-model-field="context" type="number" min="1" max="10000000" value="${escapeHtml(model.context)}"></label>
      <label>Salida máxima<input data-model-field="output" type="number" min="1" max="10000000" value="${escapeHtml(model.output)}"></label>
      <label>Rol<select data-model-field="role"><option value="main" ${model.role === 'main' ? 'selected' : ''}>Modelo principal</option><option value="small" ${model.role === 'small' ? 'selected' : ''}>Modelo pequeño</option><option value="subagent" ${model.role === 'subagent' ? 'selected' : ''}>Para subagentes</option></select><small>«Pequeño» se emitirá como <code>small_model</code>.</small></label>
      <label>Razonamiento <span class="optional">Opcional</span><select data-model-field="reasoningEffort"><option value="" ${!model.reasoningEffort ? 'selected' : ''}>Sin especificar</option><option value="low" ${model.reasoningEffort === 'low' ? 'selected' : ''}>Bajo</option><option value="medium" ${model.reasoningEffort === 'medium' ? 'selected' : ''}>Medio</option><option value="high" ${model.reasoningEffort === 'high' ? 'selected' : ''}>Alto</option></select></label>
    </div>
    <div class="model-toggles"><label><input data-model-field="tools" type="checkbox" ${model.tools ? 'checked' : ''}> Herramientas</label><label><input data-model-field="image" type="checkbox" ${model.image ? 'checked' : ''}> Acepta imágenes</label><label><input data-model-field="preserveThinking" type="checkbox" ${model.preserveThinking ? 'checked' : ''}> Preservar razonamiento</label></div>
  </article>`;
}

function renderOpenCodeAgent(agent, index, modelOptions) {
  const permissions = [['read', 'Lectura'], ['grep', 'Búsqueda'], ['shell', 'Terminal'], ['edit', 'Edición'], ['websearch', 'Web'], ['subagent', 'Subagentes']];
  return `<article class="panel opencode-agent" data-agent-id="${agent.id}"><div class="panel-header"><div><h2>Subagente ${index + 1}</h2><p>Permisos explícitos para tareas delegadas.</p></div><button class="row-action remove-opencode-agent" type="button">Eliminar</button></div><div class="form-grid agent-grid"><label>ID del agente<input data-agent-field="agentId" value="${escapeHtml(agent.agentId)}" maxlength="60" placeholder="investigador"></label><label>Modelo<select data-agent-field="modelRef"><option value="">Selecciona un modelo</option>${modelOptions.map((option) => `<option value="${escapeHtml(option.ref)}" ${agent.modelRef === option.ref ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></label><label class="wide-field">Descripción <span class="optional">Opcional</span><input data-agent-field="description" value="${escapeHtml(agent.description)}" maxlength="200" placeholder="Investiga y sintetiza información"></label></div><div class="permission-grid">${permissions.map(([key, label]) => `<label>${label}<select data-permission="${key}"><option value="" ${!agent.permissions[key] ? 'selected' : ''}>Heredar</option><option value="allow" ${agent.permissions[key] === 'allow' ? 'selected' : ''}>Permitir</option><option value="ask" ${agent.permissions[key] === 'ask' ? 'selected' : ''}>Preguntar</option><option value="deny" ${agent.permissions[key] === 'deny' ? 'selected' : ''}>Denegar</option></select></label>`).join('')}</div></article>`;
}

function findUtilityProvider(id) { return state.utility.providers.find((provider) => provider.id === id); }
function findUtilityModel(provider, id) { return provider?.models.find((model) => model.id === id); }

async function queryOpenCodeModels(providerId, discover) {
  const provider = findUtilityProvider(providerId);
  if (!provider) return;
  const baseUrl = normalizeUtilityBaseUrl(provider.baseUrl);
  if (!baseUrl) { provider.status = { online: false, message: 'URL no válida' }; renderOpenCodeUtility(); return; }
  provider.status = { online: false, message: 'Conectando…' }; renderOpenCodeUtility();
  try {
    const result = await api('/admin/api/opencode/discover-models', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey: provider.apiKey }) });
    provider.status = { online: true, message: `${result.models.length} modelo(s) · ${result.latencyMs} ms` };
    if (discover) {
      const known = new Set(provider.models.map((model) => model.modelId));
      result.models.filter((model) => !known.has(model.id)).forEach((model) => provider.models.push(createOpenCodeModel({ modelId: model.id, name: model.name })));
      if (!provider.models.some((model) => model.role === 'main') && provider.models[0]) provider.models[0].role = 'main';
    }
  } catch (error) {
    provider.status = { online: false, message: error.message || 'Sin conexión' };
  }
  renderOpenCodeUtility();
}

function validateOpenCodeJson() {
  const generated = buildOpenCodeConfig();
  const message = $('#opencode-output-message');
  try {
    const parsed = JSON.parse($('#opencode-json').textContent);
    if (parsed.$schema !== 'https://opencode.ai/config.json' || !parsed.provider || typeof parsed.provider !== 'object') throw new Error('No coincide con la estructura de OpenCode instalada.');
    if (generated.errors.length) throw new Error(generated.errors.join(' '));
    message.className = 'form-message';
    message.textContent = 'JSON válido para la estructura de OpenCode instalada.';
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message;
  }
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

$('#logout-button').addEventListener('click', async () => { try { await api('/admin/api/server-session', { method: 'DELETE' }); } catch { /* La sesión administrativa puede haber expirado. */ } localStorage.removeItem(ADMIN_TOKEN_KEY); sessionStorage.removeItem(ADMIN_TOKEN_KEY); state.token = ''; $('#admin-token').value = ''; showAuth(); });

document.querySelector('[data-route="server"]')?.addEventListener('click', async (event) => {
  event.preventDefault();
  $$('[data-page]').forEach((page) => page.classList.toggle('active', page.dataset.page === 'server'));
  $$('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.route === 'server'));
  $('#breadcrumb-page').textContent = 'SERVER';
  document.title = 'Servidor · benzIA';
  try {
    await api('/admin/api/server-session', { method: 'POST', body: '{}' });
    const frame = $('#server-frame');
    if (frame?.dataset.src && frame.src !== new URL(frame.dataset.src, window.location.href).href) frame.src = frame.dataset.src;
  } catch (error) {
    toast(error.message);
  }
});
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
  try { const payload = await api('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: $('#key-name').value, allowExternalProviders: $('#key-provider-access').value === 'external' }) }); $('#key-dialog').close(); $('#created-token').textContent = payload.key.token; $('#token-dialog').showModal(); await loadAll(); }
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
$('#add-external-provider').addEventListener('click', () => { state.settings.externalProviders.push(createExternalProvider()); renderExternalProviders(); });
$('#external-providers').addEventListener('input', (event) => {
  const card = event.target.closest('.external-provider');
  const field = event.target.dataset.externalField;
  const provider = state.settings.externalProviders[Number(card?.dataset.providerIndex)];
  if (!provider || !field) return;
  provider[field] = event.target.value;
  if (field === 'name') card.querySelector('.external-provider-head strong').textContent = event.target.value || 'Proveedor externo';
});
$('#external-providers').addEventListener('click', async (event) => {
  const card = event.target.closest('.external-provider');
  const index = Number(card?.dataset.providerIndex);
  const provider = state.settings.externalProviders[index];
  if (!provider) return;
  if (event.target.closest('.remove-external-provider')) {
    state.settings.externalProviders.splice(index, 1);
    renderExternalProviders();
    return;
  }
  if (!event.target.closest('.test-external-provider')) return;
  provider.status = { online: false, message: 'Consultando…' };
  renderExternalProviders();
  try {
    const result = await api('/admin/api/external-providers/test', { method: 'POST', body: JSON.stringify(provider) });
    provider.status = { online: true, message: `${result.models.length} modelo(s) · ${result.latencyMs} ms` };
  } catch (error) { provider.status = { online: false, message: error.message }; }
  renderExternalProviders();
});
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#settings-message'); message.className = 'form-message'; message.textContent = 'Guardando cambios…';
  try {
    const upstreamApiKey = $('#upstream-key').value;
    const braveSearchApiKey = $('#brave-search-key').value;
    await api('/admin/api/settings', { method: 'PATCH', body: JSON.stringify({
      upstreamBaseUrl: $('#upstream-url').value,
      publicGatewayUrl: $('#public-gateway-url').value,
      braveSearchEndpoint: $('#brave-search-endpoint').value,
      externalProviders: (state.settings.externalProviders || []).map((provider) => ({ id: provider.id, originalId: provider.originalId, name: provider.name, baseUrl: provider.baseUrl, apiKey: provider.apiKey, keepApiKey: provider.hasApiKey && !provider.apiKey })),
      ...(upstreamApiKey ? { upstreamApiKey } : {}),
      ...(braveSearchApiKey ? { braveSearchApiKey } : {})
    }) });
    $('#upstream-key').value = ''; $('#brave-search-key').value = ''; message.textContent = 'Configuración guardada correctamente.'; await loadAll();
  } catch (error) { message.textContent = error.message; message.classList.add('error'); }
});
$('#test-upstream').addEventListener('click', async () => { const status = await checkUpstream(); toast(status?.online ? `Proveedor IA Local responde en ${status.latencyMs} ms · ${status.models.length} modelo(s)` : 'No se puede contactar con Proveedor IA Local'); });
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#token-chart').addEventListener('mousemove', showChartTooltip);
$('#token-chart').addEventListener('mouseleave', hideChartTooltip);

$('#add-opencode-provider').addEventListener('click', () => { state.utility.providers.push(createOpenCodeProvider()); renderOpenCodeUtility(); });
$('#add-opencode-agent').addEventListener('click', () => { state.utility.agents.push(createOpenCodeAgent()); renderOpenCodeUtility(); });
$('#opencode-providers').addEventListener('click', async (event) => {
  const providerElement = event.target.closest('.opencode-provider');
  const provider = findUtilityProvider(providerElement?.dataset.providerId);
  if (!provider) return;
  if (event.target.closest('.remove-opencode-provider')) {
    state.utility.providers = state.utility.providers.filter((item) => item.id !== provider.id);
    state.utility.agents.forEach((agent) => { if (agent.modelRef.startsWith(`${provider.id}:`)) agent.modelRef = ''; });
    renderOpenCodeUtility();
  } else if (event.target.closest('.add-opencode-model')) {
    const model = createOpenCodeModel();
    if (!state.utility.providers.some((item) => item.models.some((candidate) => candidate.role === 'main'))) model.role = 'main';
    provider.models.push(model); renderOpenCodeUtility();
  } else if (event.target.closest('.remove-opencode-model')) {
    const modelElement = event.target.closest('.opencode-model');
    const model = findUtilityModel(provider, modelElement?.dataset.modelId);
    if (!model) return;
    provider.models = provider.models.filter((item) => item.id !== model.id);
    state.utility.agents.forEach((agent) => { if (agent.modelRef === `${provider.id}:${model.id}`) agent.modelRef = ''; });
    if (!state.utility.providers.some((item) => item.models.some((candidate) => candidate.role === 'main'))) {
      const fallbackProvider = state.utility.providers.find((item) => item.models.length);
      if (fallbackProvider) fallbackProvider.models[0].role = 'main';
    }
    renderOpenCodeUtility();
  } else if (event.target.closest('.test-opencode-provider')) {
    await queryOpenCodeModels(provider.id, false);
  } else if (event.target.closest('.discover-opencode-models')) {
    await queryOpenCodeModels(provider.id, true);
  } else if (event.target.closest('.toggle-utility-secret')) {
    const input = event.target.closest('.secret-input')?.querySelector('input');
    if (input) { input.type = input.type === 'password' ? 'text' : 'password'; event.target.textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar'; }
  }
});
$('#opencode-providers').addEventListener('input', (event) => {
  const provider = findUtilityProvider(event.target.closest('.opencode-provider')?.dataset.providerId);
  if (!provider) return;
  const model = findUtilityModel(provider, event.target.closest('.opencode-model')?.dataset.modelId);
  const field = event.target.dataset.modelField || event.target.dataset.providerField;
  if (!field) return;
  const target = model || provider;
  target[field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  $('#opencode-json').textContent = JSON.stringify(buildOpenCodeConfig().config, null, 2);
  const generated = buildOpenCodeConfig();
  $('#opencode-secret-warning').classList.toggle('hidden', !generated.hasSecret);
});
$('#opencode-providers').addEventListener('change', (event) => {
  const provider = findUtilityProvider(event.target.closest('.opencode-provider')?.dataset.providerId);
  const model = findUtilityModel(provider, event.target.closest('.opencode-model')?.dataset.modelId);
  const field = event.target.dataset.modelField || event.target.dataset.providerField;
  if (!provider || !field) return;
  const target = model || provider;
  target[field] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
  if (model && field === 'role' && model.role === 'main') {
    state.utility.providers.forEach((item) => item.models.forEach((candidate) => { if (candidate.id !== model.id) candidate.role = candidate.role === 'main' ? 'small' : candidate.role; }));
    renderOpenCodeUtility();
  } else {
    const generated = buildOpenCodeConfig();
    $('#opencode-json').textContent = JSON.stringify(generated.config, null, 2);
    $('#opencode-secret-warning').classList.toggle('hidden', !generated.hasSecret);
  }
});
$('#opencode-agents').addEventListener('click', (event) => {
  const agentElement = event.target.closest('.opencode-agent');
  if (!agentElement || !event.target.closest('.remove-opencode-agent')) return;
  state.utility.agents = state.utility.agents.filter((agent) => agent.id !== agentElement.dataset.agentId);
  renderOpenCodeUtility();
});
function updateOpenCodeAgent(event) {
  const agent = state.utility.agents.find((item) => item.id === event.target.closest('.opencode-agent')?.dataset.agentId);
  if (!agent) return;
  if (event.target.dataset.permission) agent.permissions[event.target.dataset.permission] = event.target.value;
  else if (event.target.dataset.agentField) agent[event.target.dataset.agentField] = event.target.value;
  const generated = buildOpenCodeConfig();
  $('#opencode-json').textContent = JSON.stringify(generated.config, null, 2);
  $('#opencode-secret-warning').classList.toggle('hidden', !generated.hasSecret);
}
$('#opencode-agents').addEventListener('input', updateOpenCodeAgent);
$('#opencode-agents').addEventListener('change', updateOpenCodeAgent);
$('#validate-opencode-json').addEventListener('click', validateOpenCodeJson);
$('#copy-opencode-json').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#opencode-json').textContent); toast('Configuración copiada'); } catch { toast('No se pudo copiar la configuración.'); }
});
$('#download-opencode-json').addEventListener('click', () => {
  const blob = new Blob([$('#opencode-json').textContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'opencode.json'; anchor.click();
  URL.revokeObjectURL(url);
});

window.addEventListener('resize', () => { clearTimeout(window.chartResize); window.chartResize = setTimeout(() => pageName === 'dashboard' && state.overview && renderTimeline(state.overview.timeline), 120); });
initializeRoute(); updateClock(); setInterval(updateClock, 1000);
api('/admin/api/session')
  .then(() => { hideAuth(); revealApp(); loadAll().catch((error) => toast(error.message)); })
  .catch(() => { showAuth(); revealApp(); });
setInterval(() => { if (state.token && document.visibilityState === 'visible' && (pageName === 'dashboard' || pageName === 'activity')) refreshOverview().catch(() => {}); }, 15000);
setInterval(() => { if (state.token && document.visibilityState === 'visible' && pageName === 'dashboard') refreshLive().catch(() => {}); }, 1000);

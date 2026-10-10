import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { once } from 'node:events';

const CLIENT_INFO = Object.freeze({ name: 'benzia', title: 'benzIA', version: '1.0.0' });
const require = createRequire(import.meta.url);

export function resolveCodexExecutable({ configuredPath = process.env.CODEX_PATH, packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  if (configuredPath) return configuredPath;
  try { return require.resolve('@openai/codex/bin/codex.js', { paths: [packageRoot] }); }
  catch { return 'codex'; }
}

export function normalizeCodexDeviceLogin(value) {
  if (!value || value.type !== 'chatgptDeviceCode' || typeof value.loginId !== 'string' || typeof value.verificationUrl !== 'string' || typeof value.userCode !== 'string') {
    throw new Error('Codex no devolvió un código de dispositivo válido.');
  }
  return { type: value.type, loginId: value.loginId, verificationUrl: value.verificationUrl, userCode: value.userCode };
}

export function normalizeCodexModels(models, selectedModel) {
  if (typeof selectedModel !== 'string' || !selectedModel) return [];
  const model = models.find((item) => item.id === selectedModel);
  if (!model) return [];
  return [{ id: `openai/${model.id}`, object: 'model', owned_by: 'OpenAI Codex', name: model.name || model.id }];
}

export function buildCodexChatCompletion(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const text = messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ') : '';
    if (!content) return '';
    return message.role === 'system' || message.role === 'developer' ? content : `${message.role}: ${content}`;
  }).filter(Boolean).join('\n\n');
  return {
    model: String(body?.model || '').replace(/^openai\//, ''),
    input: [{ type: 'text', text }],
    stream: body?.stream === true,
    effort: ['low', 'medium', 'high', 'xhigh'].includes(body?.reasoning_effort) ? body.reasoning_effort : undefined
  };
}

export class CodexAppServer {
  constructor({ request: requestOverride, spawnProcess = spawn, codexPath = resolveCodexExecutable(), homeDir = process.env.CODEX_HOME } = {}) {
    this.requestOverride = requestOverride; this.spawnProcess = spawnProcess; this.codexPath = codexPath; this.homeDir = homeDir;
    this.pending = new Map(); this.nextId = 1; this.proc = null; this.reader = null; this.starting = null; this.closed = false; this.listeners = new Map();
  }

  async ensureStarted() {
    if (this.requestOverride) return;
    if (this.closed) throw new Error('El servidor Codex se ha cerrado.');
    if (this.proc && this.proc.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const env = { ...process.env }; if (this.homeDir) env.CODEX_HOME = this.homeDir;
      const proc = this.spawnProcess(this.codexPath, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env });
      this.proc = proc; this.reader = readline.createInterface({ input: proc.stdout });
      this.reader.on('line', (line) => this.handleLine(line)); proc.stderr.on('data', () => {});
      proc.on('exit', (code) => {
        this.proc = null; const error = new Error(`Codex app-server terminó (${code ?? 'sin código'}).`);
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear();
      });
      await once(proc, 'spawn'); await this.request('initialize', { clientInfo: CLIENT_INFO }, 30000, true); this.notify('initialized', {});
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  handleLine(line) {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined || message.id === null) { if (message.method) this.emit('notification', message); return; }
    const pending = this.pending.get(message.id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'Error en Codex app-server.'));
    else pending.resolve(message.result || {});
  }
  emit(event, value) { for (const handler of this.listeners.get(event) || []) handler(value); }
  on(event, handler) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(handler); return () => this.listeners.get(event)?.delete(handler); }

  async request(method, params = {}, timeoutMs = 30000, skipStart = false) {
    if (this.requestOverride) return this.requestOverride(method, params);
    if (!skipStart) await this.ensureStarted(); const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Tiempo agotado esperando ${method} de Codex.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (!error) return; clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  notify(method, params = {}) { if (!this.requestOverride) this.proc?.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  async startDeviceLogin() { return normalizeCodexDeviceLogin(await this.request('account/login/start', { type: 'chatgptDeviceCode' })); }
  async cancelDeviceLogin(loginId) { return this.request('account/login/cancel', { loginId }); }
  async readAccount() { return this.request('account/read', {}); }
  async readRateLimits() {
    const response = await this.request('account/rateLimits/read', {});
    const limits = response.rateLimitsByLimitId?.codex || response.rateLimits;
    const windows = [limits?.primary, limits?.secondary];
    const pick = (duration) => {
      const window = windows.find((item) => item?.windowDurationMins === duration);
      if (!window || !Number.isFinite(window.usedPercent)) return null;
      return {
        usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
        resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null
      };
    };
    return { fiveHour: pick(300), weekly: pick(10080) };
  }
  async logout() { return this.request('account/logout', {}); }

  async listModels() {
    const all = []; let cursor;
    do {
      const result = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      all.push(...(Array.isArray(result.data) ? result.data : []).filter((model) => model?.id && model.hidden !== true).map((model) => ({ id: model.id, name: model.displayName || model.name || model.id })));
      cursor = result.nextCursor || null;
    } while (cursor && all.length < 2000);
    return all;
  }

  async generate(body, { signal, onDelta } = {}) {
    const request = buildCodexChatCompletion(body);
    const thread = await this.request('thread/start', { model: request.model, approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = thread.thread?.id;
    if (!threadId) throw new Error('Codex no devolvió el identificador de conversación.');
    const turnController = new AbortController();
    let turnId = null;
    const abortTurn = () => {
      turnController.abort(signal.reason || new Error('Petición cancelada.'));
      if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    };
    signal?.addEventListener('abort', abortTurn, { once: true });
    if (signal?.aborted) abortTurn();
    const completion = this.waitForTurn(threadId, null, { signal: turnController.signal, onDelta });
    const removeAbortListener = () => signal?.removeEventListener('abort', abortTurn);
    completion.then(removeAbortListener, removeAbortListener);
    try {
      const turn = await this.request('turn/start', { threadId, input: request.input, model: request.model, ...(request.effort ? { effort: request.effort } : {}) }, 120000);
      turnId = turn.turn?.id || null;
      if (!turnId) throw new Error('Codex no devolvió el identificador del turno.');
      if (signal?.aborted) abortTurn();
      return { threadId, turnId, request, completion };
    } catch (error) {
      turnController.abort(error);
      await completion.catch(() => {});
      removeAbortListener();
      throw error;
    }
  }
  waitForTurn(threadId, turnId, { signal, onDelta } = {}) {
    return new Promise((resolve, reject) => {
      let output = '';
      let deliveries = Promise.resolve();
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; off(); signal?.removeEventListener('abort', onAbort); clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const onAbort = () => finish(signal.reason || new Error('Petición cancelada.'));
      const off = this.on('notification', (message) => {
        const params = message.params || {};
        if (params.threadId !== threadId || (turnId && params.turnId && params.turnId !== turnId)) return;
        if (message.method === 'item/agentMessage/delta') {
          const delta = params.delta || '';
          output += delta;
          if (delta && onDelta) deliveries = deliveries.then(() => onDelta(delta)).catch((error) => finish(error));
        }
        if (message.method === 'item/completed' && params.item?.type === 'agentMessage') output = params.item.text || output;
        if (message.method === 'turn/completed') {
          if (params.turn?.status === 'completed') return deliveries.then(() => finish(null, output), (error) => finish(error));
          return finish(new Error(params.turn?.error?.message || `Turn Codex terminó: ${params.turn?.status || 'fallido'}.`));
        }
      });
      const timer = setTimeout(() => finish(new Error('Codex superó el tiempo máximo de generación.')), 300000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
  async close() {
    this.closed = true; if (!this.proc || this.proc.exitCode !== null) return;
    const proc = this.proc;
    const exited = once(proc, 'exit').catch(() => {});
    proc.kill('SIGTERM');
    let killTimer;
    await Promise.race([exited, new Promise((resolve) => { killTimer = setTimeout(resolve, 3000); })]);
    clearTimeout(killTimer);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
}

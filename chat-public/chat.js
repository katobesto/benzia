const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = 'benzIA_chat_conversations_v1';
const ACTIVE_KEY = 'benzIA_chat_active_v1';
const MODEL_KEY = 'benzIA_chat_model_v1';
const TOKEN_KEY = 'benzIA_chat_access_token';
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 200;
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_STORED_BYTES = 1_300_000;
const MAX_DOCUMENT_CHARS = 120_000;
let pendingMarkdownFrame = 0;

window.marked.setOptions({ gfm: true, breaks: true });

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  endpoint: '',
  identity: null,
  models: [],
  conversations: loadConversations(),
  activeId: localStorage.getItem(ACTIVE_KEY) || '',
  pendingAttachments: [],
  generating: false,
  controller: null
};

function normalizedAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ATTACHMENTS).flatMap((attachment) => {
    const name = String(attachment?.name || 'archivo').slice(0, 160);
    const size = Number(attachment?.size) || 0;
    if (attachment?.kind === 'image' && /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(attachment.dataUrl || '')) {
      return [{ kind: 'image', name, size, type: String(attachment.type || 'image/jpeg'), dataUrl: attachment.dataUrl }];
    }
    if (attachment?.kind === 'document' && typeof attachment.text === 'string' && attachment.text.trim()) {
      return [{
        kind: 'document', name, size, type: String(attachment.type || 'text/plain'),
        documentKind: String(attachment.documentKind || 'txt').slice(0, 8),
        text: attachment.text.slice(0, MAX_DOCUMENT_CHARS), truncated: Boolean(attachment.truncated)
      }];
    }
    return [];
  });
}

function loadConversations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((conversation) => conversation && typeof conversation.id === 'string')
      .slice(0, MAX_CONVERSATIONS)
      .map((conversation) => ({
        id: conversation.id,
        title: String(conversation.title || 'Nueva conversación').slice(0, 80),
        model: String(conversation.model || ''),
        createdAt: conversation.createdAt || new Date().toISOString(),
        updatedAt: conversation.updatedAt || new Date().toISOString(),
        messages: Array.isArray(conversation.messages)
          ? conversation.messages
            .filter((message) => ['user', 'assistant', 'system'].includes(message?.role) && typeof message.content === 'string')
            .slice(-MAX_MESSAGES)
            .map((message) => ({ ...message, attachments: normalizedAttachments(message.attachments) }))
          : []
      }));
  } catch {
    return [];
  }
}

function saveConversations() {
  state.conversations.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  state.conversations = state.conversations.slice(0, MAX_CONVERSATIONS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations));
    if (state.activeId) localStorage.setItem(ACTIVE_KEY, state.activeId);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    setTimeout(() => toast('El almacenamiento local está lleno; elimina algún chat antiguo.'), 0);
  }
}

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function selectedModel() {
  return $('#model-select').value || state.models[0] || '';
}

function createConversation() {
  const now = new Date().toISOString();
  const conversation = {
    id: crypto.randomUUID(),
    title: 'Nueva conversación',
    model: selectedModel(),
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  saveConversations();
  return conversation;
}

function titleFrom(text) {
  const title = text.replace(/\s+/g, ' ').trim();
  return title.length > 46 ? `${title.slice(0, 45)}…` : title;
}

function formatRelativeDate(value) {
  const time = Date.parse(value);
  const diff = Date.now() - time;
  if (diff < 60000) return 'ahora';
  if (diff < 3600000) return `hace ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `hace ${Math.floor(diff / 3600000)} h`;
  if (diff < 604800000) return `hace ${Math.floor(diff / 86400000)} d`;
  return new Date(value).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('No se pudo optimizar la imagen.')),
    'image/jpeg', quality
  ));
}

async function optimizeImage(file) {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name}: formato de imagen no reconocido.`);
  if (file.size > MAX_IMAGE_SOURCE_BYTES) throw new Error(`${file.name}: la imagen supera 10 MB.`);
  let bitmap;
  let release = () => {};
  if ('createImageBitmap' in window) {
    bitmap = await createImageBitmap(file);
    release = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file);
    bitmap = new Image();
    await new Promise((resolve, reject) => {
      bitmap.onload = resolve;
      bitmap.onerror = () => reject(new Error(`${file.name}: no se pudo decodificar la imagen.`));
      bitmap.src = url;
    });
    release = () => URL.revokeObjectURL(url);
  }
  try {
    const render = async (maxDimension, quality) => {
      const sourceWidth = bitmap.width || bitmap.naturalWidth;
      const sourceHeight = bitmap.height || bitmap.naturalHeight;
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvasToBlob(canvas, quality);
    };
    let blob = await render(1600, 0.82);
    if (blob.size > MAX_IMAGE_STORED_BYTES) blob = await render(1100, 0.72);
    if (blob.size > MAX_IMAGE_STORED_BYTES) throw new Error(`${file.name}: no se puede reducir por debajo de 1,3 MB.`);
    return {
      kind: 'image', name: file.name.slice(0, 160), type: 'image/jpeg', size: blob.size,
      dataUrl: await fileToDataUrl(blob)
    };
  } finally {
    release();
  }
}

async function extractDocumentFile(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const response = await fetch('/chat/api/attachments/extract', {
    method: 'POST', headers: { authorization: `Bearer ${state.token}` }, body: form
  });
  if (!response.ok) {
    if (response.status === 401) {
      showAccess('La clave ya no es válida. Introduce otra para adjuntar documentos.');
      throw new Error('Clave de acceso no válida.');
    }
    throw new Error(await readError(response));
  }
  const result = await response.json();
  return {
    kind: 'document', name: result.name, type: result.type, size: result.size,
    documentKind: result.kind, text: result.text, truncated: Boolean(result.truncated)
  };
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const available = MAX_ATTACHMENTS - state.pendingAttachments.length;
  if (available <= 0) return toast(`Puedes adjuntar hasta ${MAX_ATTACHMENTS} archivos por mensaje.`);
  $('#attach-button').disabled = true;
  try {
    for (const file of files.slice(0, available)) {
      try {
        const attachment = file.type.startsWith('image/') ? await optimizeImage(file) : await extractDocumentFile(file);
        state.pendingAttachments.push(attachment);
        renderPendingAttachments();
      } catch (error) {
        toast(error.message);
      }
    }
    if (files.length > available) toast(`Sólo se añadieron ${available} archivos; el máximo es ${MAX_ATTACHMENTS}.`);
  } finally {
    $('#attach-button').disabled = false;
    $('#attachment-input').value = '';
  }
}

function attachmentIcon(attachment) {
  return attachment.kind === 'image' ? 'IMG' : attachment.documentKind || 'DOC';
}

function renderPendingAttachments() {
  const tray = $('#attachment-tray');
  tray.classList.toggle('hidden', state.pendingAttachments.length === 0);
  tray.replaceChildren(...state.pendingAttachments.map((attachment, index) => {
    const item = document.createElement('div');
    item.className = 'pending-attachment';
    let preview;
    if (attachment.kind === 'image') {
      preview = document.createElement('img');
      preview.src = attachment.dataUrl;
      preview.alt = '';
    } else {
      preview = document.createElement('i');
      preview.className = 'pending-file-icon';
      preview.textContent = attachmentIcon(attachment);
    }
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = attachment.name;
    const meta = document.createElement('small');
    meta.textContent = `${attachmentIcon(attachment)} · ${formatBytes(attachment.size)}`;
    copy.append(name, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-attachment';
    remove.setAttribute('aria-label', `Quitar ${attachment.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.pendingAttachments.splice(index, 1);
      renderPendingAttachments();
    });
    item.append(preview, copy, remove);
    return item;
  }));
}

function renderHistory() {
  const list = $('#conversation-list');
  $('#conversation-count').textContent = `${state.conversations.length} LOCALES`;
  if (!state.conversations.length) {
    list.innerHTML = '<p class="empty-history">Tus conversaciones aparecerán aquí cuando envíes el primer mensaje.</p>';
    return;
  }
  list.replaceChildren(...state.conversations.map((conversation) => {
    const item = document.createElement('div');
    item.className = `conversation-item${conversation.id === state.activeId ? ' active' : ''}`;
    item.dataset.id = conversation.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `Abrir ${conversation.title}`);
    const copy = document.createElement('span');
    copy.className = 'conversation-copy';
    const title = document.createElement('strong');
    title.textContent = conversation.title;
    const meta = document.createElement('small');
    meta.textContent = `${formatRelativeDate(conversation.updatedAt)} · ${conversation.model || 'sin modelo'}`;
    copy.append(title, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-chat';
    remove.title = 'Eliminar conversación';
    remove.setAttribute('aria-label', `Eliminar ${conversation.title}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      state.conversations = state.conversations.filter((entry) => entry.id !== conversation.id);
      if (state.activeId === conversation.id) state.activeId = '';
      saveConversations();
      renderAll();
      toast('Conversación eliminada');
    });
    item.append(copy, remove);
    const openConversation = () => {
      if (state.generating) return;
      state.activeId = conversation.id;
      localStorage.setItem(ACTIVE_KEY, state.activeId);
      if (state.models.includes(conversation.model)) $('#model-select').value = conversation.model;
      renderAll();
      closeRail();
    };
    item.addEventListener('click', openConversation);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openConversation();
      }
    });
    return item;
  }));
}

function appendMessageContent(container, text) {
  const source = String(text || '');
  const rendered = window.marked.parse(source);
  container.innerHTML = window.DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'style', 'form', 'iframe', 'object', 'embed', 'video', 'audio'],
    FORBID_ATTR: ['style']
  });

  container.querySelectorAll('a').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
  });
  container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => { checkbox.disabled = true; });
  container.querySelectorAll('table').forEach((table) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    table.replaceWith(wrapper);
    wrapper.append(table);
  });
  container.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const languageClass = [...(code?.classList || [])].find((name) => name.startsWith('language-'));
    const language = languageClass ? languageClass.slice(9) : 'código';
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    const label = document.createElement('span');
    label.textContent = language;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copiar código';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(code?.textContent || '');
      copy.textContent = 'Copiado';
      setTimeout(() => { copy.textContent = 'Copiar código'; }, 1400);
    });
    toolbar.append(label, copy);
    pre.replaceWith(wrapper);
    wrapper.append(toolbar, pre);
  });
}

function messageAttachmentsElement(attachments) {
  const gallery = document.createElement('div');
  gallery.className = 'message-attachments';
  attachments.forEach((attachment) => {
    const item = document.createElement('div');
    item.className = `message-attachment ${attachment.kind}`;
    if (attachment.kind === 'image') {
      const image = document.createElement('img');
      image.src = attachment.dataUrl;
      image.alt = `Imagen adjunta: ${attachment.name}`;
      image.loading = 'lazy';
      const caption = document.createElement('span');
      caption.textContent = attachment.name;
      item.append(image, caption);
    } else {
      const icon = document.createElement('i');
      icon.textContent = attachmentIcon(attachment);
      const copy = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = attachment.name;
      const meta = document.createElement('small');
      meta.textContent = `${formatBytes(attachment.size)}${attachment.truncated ? ' · texto recortado' : ''}`;
      copy.append(name, meta);
      item.append(icon, copy);
    }
    gallery.append(item);
  });
  return gallery;
}

function contentForModel(message) {
  const attachments = normalizedAttachments(message.attachments);
  if (!attachments.length) return message.content;
  const documents = attachments.filter((attachment) => attachment.kind === 'document');
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  const documentContext = documents.map((attachment) => (
    `\n\n<documento nombre="${attachment.name.replace(/["<>]/g, '')}">\n${attachment.text}\n</documento>`
  )).join('');
  const text = `${message.content || 'Analiza los archivos adjuntos.'}${documentContext}`;
  if (!images.length) return text;
  return [
    { type: 'text', text },
    ...images.map((attachment) => ({ type: 'image_url', image_url: { url: attachment.dataUrl } }))
  ];
}

function contentForResponses(message) {
  const content = contentForModel(message);
  if (typeof content === 'string') return content;
  return content.map((item) => item.type === 'image_url'
    ? { type: 'input_image', image_url: item.image_url.url }
    : { type: 'input_text', text: item.text || '' });
}

function messageElement(message, index) {
  const article = document.createElement('article');
  article.className = `message ${message.role}${message.pending ? ' pending' : ''}${message.error ? ' error' : ''}`;
  article.dataset.index = String(index);
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = message.role === 'user' ? 'TÚ' : 'b';
  const body = document.createElement('div');
  body.className = 'message-body';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = message.role === 'user' ? 'Tú' : 'benzIA';
  const detail = document.createElement('span');
  detail.textContent = message.role === 'user' ? 'MENSAJE' : selectedModel();
  author.append(strong, detail);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-message';
  copy.textContent = 'COPIAR';
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(message.content);
    toast('Mensaje copiado');
  });
  meta.append(author, copy);
  const content = document.createElement('div');
  content.className = 'message-content';
  appendMessageContent(content, message.content || (message.pending ? 'Pensando' : ''));
  const attachments = normalizedAttachments(message.attachments);
  body.append(meta);
  if (attachments.length) body.append(messageAttachmentsElement(attachments));
  body.append(content);
  article.append(avatar, body);
  return article;
}

function renderMessages() {
  const conversation = activeConversation();
  const messages = conversation?.messages || [];
  $('#welcome').classList.toggle('hidden', messages.length > 0);
  const list = $('#message-list');
  list.classList.toggle('hidden', messages.length === 0);
  list.replaceChildren(...messages.filter((message) => message.role !== 'system').map(messageElement));
  requestAnimationFrame(() => {
    const viewport = $('#conversation');
    viewport.scrollTop = messages.length ? viewport.scrollHeight : 0;
  });
}

function renderAll() {
  renderHistory();
  renderMessages();
}

function setConnection(kind, label) {
  const status = $('#connection-state');
  status.className = `connection-state ${kind}`;
  status.querySelector('span').textContent = label;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 1800);
}

async function readError(response) {
  const payload = await response.json().catch(() => ({}));
  return payload.error?.message || payload.error || `Error HTTP ${response.status}`;
}

async function connect(token) {
  const configResponse = await fetch('/chat/api/config', { headers: { authorization: `Bearer ${token}` } });
  if (!configResponse.ok) throw new Error(configResponse.status === 401 ? 'El token no es válido o ha sido revocado.' : await readError(configResponse));
  const config = await configResponse.json();
  const modelsResponse = await fetch(`${config.endpoint}/models`, { headers: { authorization: `Bearer ${token}` } });
  if (!modelsResponse.ok) throw new Error(modelsResponse.status === 401 ? 'El endpoint configurado ha rechazado el token.' : `No se pudieron consultar los modelos: ${await readError(modelsResponse)}`);
  const payload = await modelsResponse.json();
  const models = Array.isArray(payload.data) ? payload.data.map((model) => model.id).filter(Boolean) : [];
  if (!models.length) throw new Error('El endpoint está disponible, pero no devuelve ningún modelo cargado.');

  state.token = token;
  state.endpoint = config.endpoint;
  state.identity = config.identity;
  state.models = models;
  sessionStorage.setItem(TOKEN_KEY, token);
  populateModels();
  $('#identity-pill').textContent = config.identity?.name || 'Clave activa';
  $('#access-screen').classList.add('dismissed');
  $('#access-screen').setAttribute('aria-hidden', 'true');
  document.body.classList.add('ready');
  setConnection('online', 'Conectado');
  renderAll();
  if (window.innerWidth > 620 && !window.matchMedia('(pointer: coarse)').matches) $('#message-input').focus();
}

function populateModels() {
  const select = $('#model-select');
  const conversation = activeConversation();
  const remembered = conversation?.model || localStorage.getItem(MODEL_KEY) || '';
  select.replaceChildren(...state.models.map((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    return option;
  }));
  select.value = state.models.includes(remembered) ? remembered : state.models[0];
  localStorage.setItem(MODEL_KEY, select.value);
}

function showAccess(message = '') {
  state.controller?.abort();
  state.token = '';
  state.endpoint = '';
  state.identity = null;
  state.models = [];
  sessionStorage.removeItem(TOKEN_KEY);
  document.body.classList.remove('ready');
  $('#access-screen').classList.remove('dismissed');
  $('#access-screen').setAttribute('aria-hidden', 'false');
  $('#access-error').textContent = message;
  $('#access-token').value = '';
  $('#access-token').focus();
}

function setGenerating(generating) {
  state.generating = generating;
  $('#message-input').disabled = generating;
  $('#attachment-input').disabled = generating;
  $('#attach-button').disabled = generating;
  document.querySelectorAll('.remove-attachment').forEach((button) => { button.disabled = generating; });
  $('#send-button').classList.toggle('hidden', generating);
  $('#stop-button').classList.toggle('hidden', !generating);
  $('#model-select').disabled = generating;
}

function updatePendingMessage(conversation, content) {
  const message = conversation.messages.at(-1);
  if (!message || message.role !== 'assistant') return;
  message.content = content;
  if (pendingMarkdownFrame) return;
  pendingMarkdownFrame = requestAnimationFrame(() => {
    pendingMarkdownFrame = 0;
    const element = $(`.message[data-index="${conversation.messages.length - 1}"] .message-content`);
    if (element) appendMessageContent(element, message.content || 'Pensando');
    $('#conversation').scrollTop = $('#conversation').scrollHeight;
  });
}

function consumeSse(buffer, onPayload) {
  const events = buffer.split(/\r?\n\r?\n/);
  const remainder = events.pop() || '';
  events.forEach((event) => {
    event.split(/\r?\n/).forEach((line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      try { onPayload(JSON.parse(data)); } catch { /* Se ignoran fragmentos incompletos. */ }
    });
  });
  return remainder;
}

async function requestCompletion(conversation) {
  const context = conversation.messages
    .filter((message) => !message.pending && !message.error && (message.content.trim() || normalizedAttachments(message.attachments).length))
    .map((message) => ({ role: message.role, content: contentForResponses(message) }));
  conversation.messages.push({ role: 'assistant', content: '', pending: true });
  conversation.updatedAt = new Date().toISOString();
  renderMessages();
  saveConversations();
  setGenerating(true);
  state.controller = new AbortController();

  let output = '';
  try {
    const response = await fetch(`${state.endpoint}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: conversation.model, input: context, stream: true, store: false }),
      signal: state.controller.signal
    });
    if (!response.ok) {
      if (response.status === 401) {
        showAccess('La clave ya no es válida. Introduce otra para continuar.');
        throw new Error('Clave de acceso no válida.');
      }
      throw new Error(await readError(response));
    }
    if (!response.body) throw new Error('El modelo no ha devuelto un flujo de respuesta.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeSse(buffer, (payload) => {
        const fragment = payload.type === 'response.output_text.delta'
          ? payload.delta || ''
          : payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.text ?? '';
        if (fragment) {
          output += fragment;
          updatePendingMessage(conversation, output);
        }
      });
    }
    if (!output) output = 'El modelo finalizó sin devolver contenido.';
  } catch (error) {
    const aborted = error.name === 'AbortError';
    output = output || (aborted ? 'Respuesta detenida.' : `No se pudo completar la respuesta: ${error.message}`);
    const message = conversation.messages.at(-1);
    if (message) message.error = !aborted;
  } finally {
    const message = conversation.messages.at(-1);
    if (message?.role === 'assistant') {
      message.content = output;
      delete message.pending;
    }
    conversation.updatedAt = new Date().toISOString();
    saveConversations();
    setGenerating(false);
    state.controller = null;
    renderAll();
    $('#message-input').focus();
  }
}

async function sendMessage(text) {
  if ((!text.trim() && !state.pendingAttachments.length) || state.generating) return;
  const model = selectedModel();
  if (!model) return toast('Selecciona un modelo');
  const conversation = activeConversation() || createConversation();
  conversation.model = model;
  const attachments = normalizedAttachments(state.pendingAttachments);
  conversation.messages.push({ role: 'user', content: text.trim(), attachments });
  if (conversation.messages.filter((message) => message.role === 'user').length === 1) conversation.title = titleFrom(text);
  if (!text.trim() && conversation.messages.filter((message) => message.role === 'user').length === 1) {
    conversation.title = attachments.map((attachment) => attachment.name).join(', ').slice(0, 46) || 'Archivos adjuntos';
  }
  conversation.updatedAt = new Date().toISOString();
  state.pendingAttachments = [];
  renderPendingAttachments();
  saveConversations();
  $('#message-input').value = '';
  resizeComposer();
  renderAll();
  await requestCompletion(conversation);
}

function resizeComposer() {
  const input = $('#message-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function newChat() {
  if (state.generating) return;
  state.activeId = '';
  state.pendingAttachments = [];
  renderPendingAttachments();
  localStorage.removeItem(ACTIVE_KEY);
  renderAll();
  closeRail();
  $('#message-input').focus();
}

function closeRail() { document.body.classList.remove('rail-open'); }

$('#access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('#access-token').value.trim();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $('#access-error').textContent = '';
  try {
    if (token.includes('•') || (token.startsWith('lmg_') && token.length < 40)) {
      throw new Error('Has introducido sólo el prefijo de la clave. Necesitas el token completo que se mostró al crearla.');
    }
    await connect(token);
  }
  catch (error) { $('#access-error').textContent = error.message; setConnection('error', 'Sin conexión'); }
  finally { button.disabled = false; }
});

$('#toggle-token').addEventListener('click', () => {
  const input = $('#access-token');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#toggle-token').textContent = input.type === 'password' ? 'VER' : 'OCULTAR';
});

$('#composer').addEventListener('submit', (event) => { event.preventDefault(); sendMessage($('#message-input').value); });
$('#message-input').addEventListener('input', resizeComposer);
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage(event.currentTarget.value);
  }
});
$('#stop-button').addEventListener('click', () => state.controller?.abort());
$('#new-chat').addEventListener('click', newChat);
$('#change-token').addEventListener('click', () => showAccess());
$('#attach-button').addEventListener('click', () => $('#attachment-input').click());
$('#attachment-input').addEventListener('change', (event) => addFiles(event.currentTarget.files));
$('#mobile-rail').addEventListener('click', () => document.body.classList.add('rail-open'));
$('#rail-close').addEventListener('click', closeRail);
$('#model-select').addEventListener('change', (event) => {
  localStorage.setItem(MODEL_KEY, event.currentTarget.value);
  const conversation = activeConversation();
  if (conversation && !conversation.messages.length) conversation.model = event.currentTarget.value;
});
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  $('#message-input').value = button.dataset.prompt;
  resizeComposer();
  $('#message-input').focus();
}));

const composer = $('#composer');
composer.addEventListener('dragover', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  composer.classList.add('dragging');
});
composer.addEventListener('dragleave', (event) => {
  if (!composer.contains(event.relatedTarget)) composer.classList.remove('dragging');
});
composer.addEventListener('drop', (event) => {
  event.preventDefault();
  composer.classList.remove('dragging');
  addFiles(event.dataTransfer.files);
});
$('#message-input').addEventListener('paste', (event) => {
  const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
});

renderPendingAttachments();
renderAll();
if (state.token) connect(state.token).catch((error) => showAccess(error.message));
else showAccess();

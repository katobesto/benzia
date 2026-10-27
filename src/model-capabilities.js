import fs from 'node:fs/promises';
import path from 'node:path';

export const CAPABILITIES_FILENAME = 'model-capabilities.json';
export const MAX_CAPABILITIES = 200;
const MODALITIES = new Set(['text', 'image']);
const QWEN38_REASONING_EFFORTS = ['none', 'low', 'medium', 'xhigh'];
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function qwen38Family(modelId) {
  const normalized = String(modelId || '').replace(/[._\s-]/g, '');
  if (/qwen38.*flashnext|qwen.*flash.*next.*38/i.test(normalized)) return 'qwen38';
  if (/qwen38.*27b|qwen.*27b.*38/i.test(normalized)) return 'qwen38';
  if (/qwen38/i.test(normalized)) return 'qwen38';
  return '';
}

export function reasoningEffortsForModel(modelId, capabilities = {}) {
  const normalizedId = String(modelId || '');
  const matchingId = Object.keys(capabilities).find((id) => normalizedId === id || normalizedId.endsWith(`/${id}`));
  const declared = capabilities[normalizedId]?.reasoning_effort || capabilities[matchingId]?.reasoning_effort;
  if (declared) return [...declared];
  const family = qwen38Family(modelId);
  if (family === 'qwen38') return [...QWEN38_REASONING_EFFORTS];
  return [];
}

/**
 * Normaliza y valida el mapa de capacidades de modelo.
 *
 * Formato esperado (data/model-capabilities.json):
 * {
 *   "unsloth/qwen3.8-27b-gguf/qwen3.8-27b-ud-q4_k_s.gguf": {
 *     "input": ["text"], "output": ["text"], "context_length": 262144,
 *     "max_completion_tokens": 65536, "reasoning_effort": ["none", "low", "medium", "xhigh"]
 *   },
 *   "qwen2.5-vl-7b-instruct-q4_k_m.gguf": { "input": ["text", "image"] }
 * }
 *
 * `input` es opcional (por defecto ["text"]), no puede estar vacío y si se
 * declara debe incluir "text"; `output` es opcional y por defecto es
 * ["text"]. Las modalidades admitidas son "text" y "image". Las claves admiten el ID público del
 * modelo (con el prefijo de proveedor externo, p. ej. "cloud/modelo") o el
 * ID que reporta el proveedor.
 */
export function sanitizeModelCapabilities(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('El mapa de capacidades de modelos debe ser un objeto JSON.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_CAPABILITIES) {
    throw new Error(`Se admiten hasta ${MAX_CAPABILITIES} capacidades de modelo.`);
  }
  const normalizeModalities = (field, modelId, list, fallback) => {
    if (list === undefined || list === null) return [...fallback];
    if (!Array.isArray(list)) {
      throw new Error(`Las ${field} de "${modelId}" deben ser una lista de modalidades.`);
    }
    const seen = new Set();
    const modalities = [];
    for (const modality of list) {
      if (!MODALITIES.has(modality)) {
        throw new Error(`"${modelId}" declara la modalidad no válida "${String(modality)}"; las admitidas son text e image.`);
      }
      if (!seen.has(modality)) {
        seen.add(modality);
        modalities.push(modality);
      }
    }
    if (modalities.length === 0) {
      throw new Error(`Las ${field} de "${modelId}" no pueden estar vacías.`);
    }
    if (field === 'modalidades de entrada' && !modalities.includes('text')) {
      throw new Error(`Las modalidades de entrada de "${modelId}" deben incluir "text".`);
    }
    return modalities;
  };
  const result = {};
  for (const [rawId, raw] of entries) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) throw new Error('Cada capacidad debe nombrar un ID de modelo.');
    if (id.length > 300) throw new Error(`El ID de modelo "${id}" es demasiado largo.`);
    if (result[id]) throw new Error(`El ID de modelo "${id}" está repetido en el mapa de capacidades.`);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Las capacidades de "${id}" deben ser un objeto con "input" (y opcional "output").`);
    }
    result[id] = {
      input: normalizeModalities('modalidades de entrada', id, raw.input, ['text']),
      output: normalizeModalities('modalidades de salida', id, raw.output, ['text'])
    };
    for (const field of ['context_length', 'max_completion_tokens']) {
      if (raw[field] === undefined || raw[field] === null) continue;
      if (!Number.isSafeInteger(raw[field]) || raw[field] < 1 || raw[field] > 10000000) {
        throw new Error(`"${id}" debe declarar ${field} como un entero entre 1 y 10000000.`);
      }
      result[id][field] = raw[field];
    }
    if (raw.reasoning_effort !== undefined && raw.reasoning_effort !== null) {
      if (!Array.isArray(raw.reasoning_effort) || raw.reasoning_effort.length === 0) {
        throw new Error(`El esfuerzo de razonamiento de "${id}" debe ser una lista no vacía.`);
      }
      const efforts = [...new Set(raw.reasoning_effort)];
      const invalid = efforts.find((effort) => !REASONING_EFFORTS.has(effort));
      if (invalid) throw new Error(`"${id}" declara el esfuerzo no válido "${String(invalid)}".`);
      result[id].reasoning_effort = efforts;
    }
  }
  return result;
}

/**
 * Lee el archivo de capacidades del directorio de datos. Un archivo ausente
 * simplemente no declara capacidades; un archivo corrupto se ignora con un
 * aviso para no romper la lista pública de modelos.
 */
export async function loadModelCapabilities(dataDir) {
  if (!dataDir) return {};
  let raw;
  try {
    raw = await fs.readFile(path.join(dataDir, CAPABILITIES_FILENAME), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.error(`No se pudo leer ${CAPABILITIES_FILENAME}; se ignoran las capacidades declaradas:`, error.message);
    return {};
  }
  try {
    // UTF-8 BOM is valid in many editors but JSON.parse rejects it. Ignore it
    // at the boundary so manually saved files work just like API-written ones.
    return sanitizeModelCapabilities(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch (error) {
    console.error(`${CAPABILITIES_FILENAME} no es válido; se ignoran las capacidades declaradas:`, error.message);
    return {};
  }
}

/**
 * Devuelve una copia del modelo con `input_modalities` y `output_modalities`
 * cuando el mapa lo declara. También anota parámetros conocidos de benzIA.
 * Prueba primero el ID público expuesto (con el prefijo externo) y después
 * el ID original del proveedor, de modo que una sola entrada cubra ambos.
 */
export function annotateModel(model, capabilities = {}) {
  if (!model || typeof model !== 'object' || typeof model.id !== 'string') return model;
  let declared = capabilities[model.id];
  if (!declared && model.benzIA_provider && typeof model.benzIA_provider.id === 'string') {
    const prefix = `${model.benzIA_provider.id}/`;
    if (model.id.startsWith(prefix)) declared = capabilities[model.id.slice(prefix.length)];
  }
  const efforts = declared?.reasoning_effort || reasoningEffortsForModel(model.id);
  if (!declared && !efforts.length) return model;
  return {
    ...model,
    ...(declared ? { input_modalities: [...declared.input], output_modalities: [...declared.output] } : {}),
    ...(declared?.context_length ? { context_length: declared.context_length } : {}),
    ...(declared?.max_completion_tokens ? { top_provider: { ...(model.top_provider && typeof model.top_provider === 'object' ? model.top_provider : {}), max_completion_tokens: declared.max_completion_tokens } } : {}),
    ...(efforts.length ? {
      supported_parameters: [...new Set([...(Array.isArray(model.supported_parameters) ? model.supported_parameters : []), 'reasoning_effort'])],
      benzIA_supported_parameters: {
        ...(model.benzIA_supported_parameters || {}),
        reasoning_effort: { type: 'string', enum: [...efforts] }
      }
    } : {})
  };
}

export function annotateModels(models, capabilities) {
  return (Array.isArray(models) ? models : []).map((model) => annotateModel(model, capabilities));
}

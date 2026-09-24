import fs from 'node:fs/promises';
import path from 'node:path';

export const CAPABILITIES_FILENAME = 'model-capabilities.json';
export const MAX_CAPABILITIES = 200;
const MODALITIES = new Set(['text', 'image']);

/**
 * Normaliza y valida el mapa de capacidades de modelo.
 *
 * Formato esperado (data/model-capabilities.json):
 * {
 *   "unsloth/qwen3.8-27b-gguf/qwen3.8-27b-ud-q4_k_s.gguf": { "input": ["text"], "output": ["text"] },
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
    return sanitizeModelCapabilities(JSON.parse(raw));
  } catch (error) {
    console.error(`${CAPABILITIES_FILENAME} no es válido; se ignoran las capacidades declaradas:`, error.message);
    return {};
  }
}

/**
 * Devuelve una copia del modelo con `input_modalities` y `output_modalities`
 * cuando el mapa lo declara. Prueba primero el ID público expuesto (con el
 * prefijo de proveedor externo) y después el ID original del proveedor, de
 * modo que una sola entrada cubra ambos.
 */
export function annotateModel(model, capabilities = {}) {
  if (!model || typeof model !== 'object' || typeof model.id !== 'string') return model;
  let declared = capabilities[model.id];
  if (!declared && model.benzIA_provider && typeof model.benzIA_provider.id === 'string') {
    const prefix = `${model.benzIA_provider.id}/`;
    if (model.id.startsWith(prefix)) declared = capabilities[model.id.slice(prefix.length)];
  }
  if (!declared) return model;
  return {
    ...model,
    input_modalities: [...declared.input],
    output_modalities: [...declared.output]
  };
}

export function annotateModels(models, capabilities) {
  return (Array.isArray(models) ? models : []).map((model) => annotateModel(model, capabilities));
}
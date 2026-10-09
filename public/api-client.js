export async function parseApiResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || 'content-type no informado';
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`El servidor devolvió una respuesta que no es JSON válido (HTTP ${response.status}; ${contentType}). Comprueba la ruta de la API y la versión del servicio.`);
  }
  if (!response.ok) throw new Error(payload?.error || `Error ${response.status}`);
  return payload;
}

export async function parseApiResponse(response) {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || 'content-type no informado';
  const body = await response.text();
  const requestId = response.headers.get('x-request-id') || response.headers.get('cf-ray');
  const reference = requestId && /^[\w-]{1,100}$/.test(requestId) ? ` Referencia: ${requestId}.` : '';
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`El servidor devolvió una respuesta que no es JSON válido (HTTP ${response.status}; ${contentType}).${reference} Comprueba el proxy y los logs del servicio.`);
  }
  if (!response.ok) throw new Error(`${payload?.error || `Error ${response.status}`}${reference}`);
  return payload;
}

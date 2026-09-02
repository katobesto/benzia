export function extractAccessToken(req) {
  const authorization = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return req.get('x-api-key')?.trim() || '';
}

export function accessAuth(store) {
  return (req, res, next) => {
    const accessKey = store.findKeyByToken(extractAccessToken(req));
    if (!accessKey) {
      return res.status(401).json({
        error: {
          message: 'Clave de acceso ausente, revocada o no válida.',
          type: 'invalid_api_key',
          code: 'invalid_api_key',
          param: null
        }
      });
    }
    req.accessKey = accessKey;
    return next();
  };
}

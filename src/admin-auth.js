import crypto from 'node:crypto';

export function extractAdminToken(req) {
  const headerToken = req.get('x-admin-token');
  if (headerToken) return headerToken;

  const authorization = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

export function timingSafeMatch(candidate, expected) {
  const a = Buffer.from(candidate || '');
  const b = Buffer.from(expected || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function adminAuth(expectedToken) {
  return (req, res, next) => {
    if (timingSafeMatch(extractAdminToken(req), expectedToken)) return next();
    return res.status(401).json({ error: 'Token administrativo no válido.' });
  };
}

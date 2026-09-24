export function jsonBodyErrorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);

  const parseError = error?.type === 'entity.parse.failed' || error instanceof SyntaxError;
  const tooLarge = error?.type === 'entity.too.large' || error?.status === 413 || error?.statusCode === 413;
  if (parseError) {
    return res.status(400).json({
      error: {
        message: 'El cuerpo JSON no es válido o está incompleto.',
        type: 'invalid_json',
        code: 'invalid_json',
        param: null
      }
    });
  }
  if (tooLarge) {
    return res.status(413).json({
      error: {
        message: 'El cuerpo de la petición supera el límite permitido.',
        type: 'request_too_large',
        code: 'request_too_large',
        param: null
      }
    });
  }
  return next(error);
}

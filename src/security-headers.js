import helmet from 'helmet';

// `upgrade-insecure-requests` tells the browser to rewrite every http://
// subresource (CSS, JS, images) to https://. When the gateway is served over
// plain HTTP on a LAN address there is no HTTPS listener, so the page loads but
// every stylesheet and script fails and the UI appears unstyled. localhost is
// exempt because browsers treat it as a trustworthy origin.
// The directive is therefore only emitted when the gateway really speaks HTTPS,
// unless CSP_UPGRADE_INSECURE_REQUESTS forces it (e.g. HTTPS behind a proxy).
export function securityHeaders(config, directives = {}) {
  const upgradeInsecureRequests = config?.cspUpgradeInsecureRequests === true;
  const finalDirectives = { ...directives };
  if (!upgradeInsecureRequests) finalDirectives['upgrade-insecure-requests'] = null;
  return helmet({ contentSecurityPolicy: { directives: finalDirectives } });
}

'use strict';
// RoPro-compatible API for rokori.  node server.js   (Node 18+, no dependencies)
const http = require('http');
const path = require('path');
const { parseRequest, corsHeaders, send } = require('./src/http');
const { Store } = require('./src/db');
const { Rokori } = require('./src/rokori');
const { Themes } = require('./src/themes');
const { makeHandlers } = require('./src/handlers');

const env = process.env;
const config = {
  port: parseInt(env.PORT || '8787', 10),
  host: env.HOST || '0.0.0.0',
  rokoriOrigin: (env.ROKORI_ORIGIN || 'https://www.rokori.com').replace(/\/$/, ''),
  allowedOrigins: (env.ALLOWED_ORIGINS || 'https://www.rokori.com,https://rokori.com').split(',').map((s) => s.trim()).filter(Boolean),
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  disabledFeatures: env.DISABLED_FEATURES || '',
  themeCacheMinutes: parseInt(env.THEME_CACHE_MINUTES || '60', 10),
  trustProxy: env.TRUST_PROXY === '1',
  rateLimitPerMin: parseInt(env.RATE_LIMIT_PER_MIN || '600', 10),
};

const db = new Store(config.dataDir);
const rokori = new Rokori(config.rokoriOrigin);
const themes = new Themes({ cacheMinutes: config.themeCacheMinutes });
const handlers = makeHandlers({ db, rokori, themes, config });

// --- rate limiting (per IP, per minute; verification endpoints much stricter) ---
const buckets = new Map();
function limited(ip, key, max) {
  const k = ip + '|' + key, now = Date.now();
  let b = buckets.get(k);
  if (!b || b.reset < now) { b = { n: 0, reset: now + 60000 }; buckets.set(k, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req, config.allowedOrigins);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);
    const ip = clientIp(req);
    const parsed = await parseRequest(req);
    const route = parsed.path.replace(/^\/+/, '');

    if (route === '' || route === 'health') {
      return send(res, 200, { ok: true, service: 'ropro-rokori-api', rokori: config.rokoriOrigin }, cors);
    }
    if (route === 'themeFrame.php' || route === 'themeFrameVideo.php') {
      return send(res, 302, '', Object.assign({ Location: themes.frameRedirect(parsed.query, route === 'themeFrameVideo.php') }, cors));
    }
    const handler = Object.prototype.hasOwnProperty.call(handlers, route) ? handlers[route] : null;
    if (!handler) return send(res, 404, { error: true, code: 'ERR-GN-404', message: 'unknown endpoint ' + route }, cors);

    if (limited(ip, 'all', config.rateLimitPerMin)) return send(res, 429, { error: true, code: 'ERR-RL-4290' }, cors);
    if (route.startsWith('rokori/verify') && limited(ip, 'verify', 20)) return send(res, 429, { error: true, code: 'ERR-RL-4291' }, cors);

    let out = await handler(req, parsed);
    let status = 200;
    if (Array.isArray(out) && out.length === 2 && typeof out[0] === 'number') [status, out] = out;
    if (typeof out === 'number' || typeof out === 'boolean') out = JSON.stringify(out);
    return send(res, status, out, cors);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(new Date().toISOString(), req.method, req.url, e);
    return send(res, status, { error: true, code: e.code || 'ERR-GN-' + status, message: status >= 500 ? 'internal error' : e.message }, cors);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`ropro-rokori-api listening on http://${config.host}:${config.port} (rokori: ${config.rokoriOrigin})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { db.flushSync(); process.exit(0); });

'use strict';
// Minimal HTTP helpers: body parsing (multipart, urlencoded, json), responses, CORS.

const MAX_BODY = 1024 * 1024; // 1 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parses multipart/form-data text fields (files are ignored).
function parseMultipart(buf, boundary) {
  const out = {};
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    const part = buf.slice(start + 2, next - 2); // strip leading CRLF and trailing CRLF
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const head = part.slice(0, sep).toString('utf8');
      const m = head.match(/name="([^"]*)"/i);
      if (m && !/filename=/i.test(head)) out[m[1]] = part.slice(sep + 4).toString('utf8');
    }
    pos = next;
  }
  return out;
}

async function parseRequest(req) {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams.entries());
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    const buf = await readBody(req);
    const ct = String(req.headers['content-type'] || '');
    if (buf.length) {
      if (ct.startsWith('multipart/form-data')) {
        const b = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (b) body = parseMultipart(buf, b[1] || b[2]);
      } else if (ct.startsWith('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(buf.toString('utf8')).entries());
      } else {
        const text = buf.toString('utf8');
        try { body = JSON.parse(text); } catch (e) { body = { _raw: text }; }
      }
    }
    // RoPro "wrap_json" requests send a single form field `data` containing JSON
    if (body && typeof body.data === 'string' && Object.keys(body).length === 1) {
      try { body = Object.assign({ _wrapped: true }, JSON.parse(body.data)); } catch (e) { /* keep as-is */ }
    }
  }
  return { url, path: url.pathname, query, body };
}

function corsHeaders(req, allowedOrigins) {
  const origin = req.headers.origin;
  const h = {};
  if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
    h['Vary'] = 'Origin';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = req.headers['access-control-request-headers'] || '*';
    h['Access-Control-Expose-Headers'] = 'x-ropro-session-token';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function send(res, status, body, headers = {}) {
  let payload = body;
  let type = headers['Content-Type'];
  if (body === undefined || body === null) payload = '';
  else if (Buffer.isBuffer(body)) { /* as-is */ }
  else if (typeof body === 'string') { type = type || 'text/plain; charset=utf-8'; }
  else { payload = JSON.stringify(body); type = type || 'application/json; charset=utf-8'; }
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' }, headers));
  res.end(payload);
}

module.exports = { parseRequest, corsHeaders, send };

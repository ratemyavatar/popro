'use strict';
// Smoke test: starts the server on a random port with a temp data dir and checks the core endpoints.
// Run: npm test   (needs network access to www.rokori.com and api.ropro.io)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const port = 20000 + Math.floor(Math.random() * 20000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ropro-api-test-'));
const TOKEN = 'smoketesttoken0000000000000000000000000000000000000000000000000';
fs.writeFileSync(path.join(dataDir, 'tokens.json'), JSON.stringify({ [TOKEN]: { userId: 112, created: 0 } }));

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }), stdio: 'inherit' });
const B = `http://127.0.0.1:${port}`;
const auth = { 'ropro-id': '112', 'ropro-verification': TOKEN };
const call = async (p, opts = {}) => { const r = await fetch(B + p, Object.assign({ method: 'POST' }, opts)); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { status: r.status, body: j, headers: r.headers }; };

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/health'); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name + ': ' + e.message]); } };

  await check('health', async () => assert.equal((await call('/health', { method: 'GET' })).body.ok, true));
  await check('subscription is free tier', async () => assert.equal((await call('/getSubscription.php')).body, 'free_tier'));
  await check('CORS preflight for rokori', async () => {
    const r = await fetch(B + '/getProfileTheme.php', { method: 'OPTIONS', headers: { Origin: 'https://www.rokori.com', 'Access-Control-Request-Headers': 'ropro-id' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://www.rokori.com');
  });
  await check('RoPro theme catalog relayed', async () => { const b = (await call('/getThemesV2.json?1=')).body; assert.ok(Array.isArray(b.themes) && b.themes.length > 0, 'no themes'); });
  await check('theme frame redirects to RoPro', async () => { const r = await fetch(B + '/themeFrame.php?theme=Ace.png', { redirect: 'manual' }); assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^https:\/\/api\.ropro\.io\/themeFrame\.php/); });
  await check('save requires auth', async () => assert.equal((await call('/saveProfileTheme.php?userid=112&themename=Ace.png&version=2')).status, 401));
  await check('save + read profile theme', async () => {
    assert.equal((await call('/saveProfileTheme.php?userid=112&themename=Ace.png&version=2', { headers: auth })).body, 'SUCCESS');
    assert.equal(JSON.parse((await call('/getProfileTheme.php?userid=112')).body.theme).name, 'Ace.png');
  });
  await check('last online', async () => {
    const fd = new FormData(); fd.append('visible', '1'); fd.append('timezone', 'UTC');
    await call('/updateLastOnline.php', { headers: auth, body: fd });
    const b = (await call('/getUserLastOnline.php?userid=112', { method: 'GET' })).body; assert.equal(b.available, true); assert.ok(b.lastOnline);
  });
  await check('playtime + most played', async () => {
    assert.equal((await call('/postTimePlayed.php?gameid=1175627&universeid=1175627&minutes=12', { headers: auth })).body, 'success');
    assert.equal((await call('/getMostPlayedUniverse.php?time=7', { headers: auth })).body[0].time_played, 12);
  });
  await check('reputation', async () => {
    // user 112 likes user 1's profile -> user 1 has reputation 1
    const fd = new FormData(); fd.append('reqType', 'add'); fd.append('myUser', '112'); fd.append('theirUser', '1');
    assert.equal((await call('/postReputation.php', { headers: auth, body: fd })).body, 'success');
    assert.equal((await call('/getUserInfo.php?userid=1&myid=112', { headers: auth })).body.reputation, 1);
  });
  await check('verify start returns phrase', async () => { const b = (await call('/rokori/verify/start', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 112 }) })).body; assert.match(b.phrase, /^ropro-/); });
  await check('validateUser', async () => { const fd = new FormData(); fd.append('userId', '112'); assert.match(String((await call('/validateUser.php', { body: fd })).body), /^112,/); });

  for (const [s, n] of results) console.log(s.padEnd(5), n);
  srv.kill();
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
})();

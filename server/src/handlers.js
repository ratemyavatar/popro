'use strict';
// RoPro-compatible endpoints for rokori. Paths match RoPro's API (e.g. /getProfileTheme.php) so the
// patched extension can talk to this server unchanged. Accounts are rokori accounts, verified by a
// phrase in the user's rokori bio. Subscription is always the free tier.
const crypto = require('crypto');

const DAY = 86400000;
const WORDS = ['maple', 'otter', 'frost', 'comet', 'pixel', 'cobalt', 'ember', 'willow', 'nova', 'pebble', 'cedar', 'falcon', 'lumen', 'tidal', 'quartz', 'aspen'];

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return undefined; };
const nowIso = () => new Date().toISOString();

function makeHandlers({ db, rokori, themes, config }) {
  const tokens = db.col('tokens');       // token -> { userId, created }
  const pending = db.col('pending');     // userId -> { phrase, created }
  const users = db.col('users');         // userId -> { lastOnline, visible, timezone, theme, discord, likedBy:{}, since }
  const playtime = db.col('playtime');   // userId -> { universeId -> { dayIndex -> minutes } }
  const idem = db.col('idempotency');    // key -> ts
  const games = db.col('games');         // universeId -> game row
  const invites = db.col('invites');     // key -> { placeid, jobid, universeid, created }
  const reports = db.col('reports');     // id -> report

  const user = (id) => { const k = String(id); if (!users[k]) { users[k] = { likedBy: {} }; } return users[k]; };

  // ---------- auth ----------
  function authUser(req) {
    const id = int(req.headers['ropro-id']);
    const tok = String(req.headers['ropro-verification'] || '');
    const rec = tok && tokens[tok];
    if (rec && id != null && rec.userId === id) return id;
    return null;
  }
  function requireAuth(req) {
    const id = authUser(req);
    if (id == null) { const e = new Error('verification required'); e.status = 401; e.code = 'ERR-AU-4010'; throw e; }
    return id;
  }

  // ---------- game cache (fed by rokori's public API) ----------
  async function refreshUniverses(universeIds) {
    const ids = [...new Set(universeIds.map(int).filter((x) => x > 0))];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const [info, votes, icons] = await Promise.all([
        rokori.games(batch).catch(() => ({ data: [] })),
        rokori.get('/v1/games/votes?universeIds=' + batch.join(','), 5 * 60000).catch(() => ({ data: [] })),
        rokori.gameIcons(batch),
      ]);
      const voteBy = Object.fromEntries((votes.data || []).map((v) => [v.id, v]));
      const iconBy = Object.fromEntries((icons.data || []).map((v) => [v.targetId, v.imageUrl]));
      for (const g of info.data || []) {
        const v = voteBy[g.id] || {};
        const icon = iconBy[g.id];
        games[g.id] = {
          id: g.id, universeId: g.id, rootPlaceId: g.rootPlaceId, name: g.name,
          playing: g.playing || 0, visits: g.visits || 0, favoritedCount: g.favoritedCount || 0,
          upVotes: v.upVotes || 0, downVotes: v.downVotes || 0,
          genre: g.genre || '', genre_l1: g.genre_l1 || g.genre || '', genre_l2: g.genre_l2 || '',
          thumbnail: icon ? new URL(icon, config.rokoriOrigin).href : '',
          creatorId: g.creator ? g.creator.id : null, updated: Date.now(),
        };
      }
    }
    db.touch('games');
  }
  async function universeForPlace(placeId) {
    const known = Object.values(games).find((g) => g.rootPlaceId === placeId);
    if (known) return known.id;
    try { const u = await rokori.universeForPlace(placeId); return int(u.universeId); } catch (e) { return null; }
  }
  const votePct = (g) => { const t = g.upVotes + g.downVotes; return t ? Math.round((g.upVotes / t) * 100) : 0; };
  function sortGames(list, order) {
    const o = String(order || '').toLowerCase();
    const by = {
      visits: (a, b) => b.visits - a.visits, likes: (a, b) => votePct(b) - votePct(a), rating: (a, b) => votePct(b) - votePct(a),
      favorites: (a, b) => b.favoritedCount - a.favoritedCount, newest: (a, b) => b.id - a.id, updated: (a, b) => b.updated - a.updated,
    };
    return list.sort(by[Object.keys(by).find((k) => o.includes(k))] || ((a, b) => b.playing - a.playing || b.visits - a.visits));
  }

  // ---------- playtime ----------
  const dayIndex = (t = Date.now()) => Math.floor(t / DAY);
  function minutesFor(uid, universeId, days) {
    const rec = (playtime[uid] || {})[universeId] || {};
    const from = dayIndex() - Math.max(0, days || 0);
    return Object.entries(rec).reduce((s, [d, m]) => (int(d) >= from ? s + m : s), 0);
  }

  // ---------- last online ----------
  function lastOnlineOf(id) {
    const u = users[String(id)];
    if (!u || !u.lastOnline) return { available: false };
    return { available: true, isVisible: u.visible !== false, lastOnline: u.visible === false ? null : u.lastOnline, timezone: u.timezone || null };
  }

  const ok = 'success';
  const H = {
    // ----- account / verification -----
    async 'rokori/verify/start'(req, { body }) {
      const userId = int(pick(body, 'userId', 'userid'));
      if (userId == null) return [400, { error: true, code: 'ERR-RQ-4000', message: 'userId required' }];
      const u = await rokori.user(userId);
      const existing = pending[userId];
      if (existing && Date.now() - existing.created < DAY) return { phrase: existing.phrase, username: u.name };
      const w = () => WORDS[crypto.randomInt(WORDS.length)];
      const phrase = `ropro-${String(u.name).toLowerCase()}-${w()}-${w()}-${crypto.randomInt(10, 100)}`;
      pending[userId] = { phrase, created: Date.now() }; db.touch('pending');
      return { phrase, username: u.name };
    },
    async 'rokori/verify/check'(req, { body }) {
      const userId = int(pick(body, 'userId', 'userid'));
      const p = userId != null && pending[userId];
      if (!p) return [400, { error: true, code: 'ERR-RQ-4001', message: 'start verification first' }];
      const u = await rokori.user(userId, true);
      if (!String(u.description || '').toLowerCase().includes(p.phrase.toLowerCase())) return { verified: false };
      const token = crypto.randomBytes(32).toString('hex');
      tokens[token] = { userId, created: Date.now() }; db.touch('tokens');
      delete pending[userId]; db.touch('pending');
      const rec = user(userId); if (!rec.since) rec.since = nowIso().slice(0, 10); db.touch('users');
      return { verified: true, token, userid: userId, username: u.name };
    },
    async 'validateUser.php'(req, { body, query }) {
      const userId = int(pick(body, 'userId', 'userid') ?? pick(query, 'userId', 'userid')) ?? authUser(req);
      if (userId == null) return 'err';
      const u = await rokori.user(userId).catch(() => null);
      return u ? `${u.id},${u.name}` : 'err';
    },
    'ingameVerification.php'() { return [400, { error: true, code: 'ERR-RQ-4002', message: 'use bio verification' }]; },
    'getSubscription.php'() { return 'free_tier'; },
    'activateKey.php'() { return 'invalid_key'; },
    'freeTrialTime.php'() { return 0; },
    'getFreeGrantWindow.php'() { return { status: 'none' }; },
    'handleRoProAlert.php'() { return Buffer.from(JSON.stringify({ alert: false })).toString('base64'); },
    'disabledFeatures.php'() { return config.disabledFeatures; },

    // ----- themes -----
    'getThemesV2.json'() { return themes.themesV2(); },
    'getVideoThemesV2.json'() { return themes.videoThemesV2(); },
    'getDefaultThemes.php'() { return themes.defaultThemes(); },
    'getProfileTheme.php'(req, { query }) {
      const u = users[String(int(query.userid))];
      return { theme: (u && u.theme) || '' };
    },
    'saveProfileTheme.php'(req, { query }) {
      const uid = requireAuth(req);
      if (int(query.userid) !== uid) return [403, { error: true, code: 'ERR-AU-4030' }];
      const name = String(query.themename || '').slice(0, 256);
      const version = int(query.version) || 2;
      const t = { name, version };
      if (query.h != null && query.s != null && query.l != null) { t.h = int(query.h); t.s = parseFloat(query.s); t.l = parseFloat(query.l); }
      user(uid).theme = name && name !== 'remove' ? JSON.stringify(t) : ''; db.touch('users');
      return 'SUCCESS';
    },

    // ----- profile -----
    'getUserInfo.php'(req, { query }) {
      const u = users[String(int(query.userid))] || {};
      const me = authUser(req);
      const likedBy = u.likedBy || {};
      return { reputation: Object.keys(likedBy).length, liked: me != null && !!likedBy[me], discord: u.discord || '', tier: 'none', user_since: u.since || '', subscribed_for: '', icons: [] };
    },
    'postReputation.php'(req, { body }) {
      const uid = requireAuth(req);
      const their = int(body.theirUser);
      if (their == null || their === uid || int(body.myUser) !== uid) return 'error';
      const t = user(their);
      if (body.reqType === 'add') t.likedBy[uid] = 1; else delete t.likedBy[uid];
      db.touch('users'); return ok;
    },
    'saveDiscord.php'(req, { body, query }) {
      const uid = requireAuth(req);
      const d = String(pick(body, 'discord') ?? pick(query, 'discord') ?? '').trim().toLowerCase();
      if (d && !/^[a-z0-9._]{2,32}$/.test(d)) return 'ERROR FORMATTING';
      user(uid).discord = d; db.touch('users'); return 'SUCCESS';
    },
    'getUserLastOnline.php'(req, { query }) { return lastOnlineOf(int(query.userid)); },
    'getUsersLastOnline.php'(req, { query }) {
      const ids = String(query.userIds || '').split(',').map(int).filter((x) => x > 0).slice(0, 200);
      return { results: Object.fromEntries(ids.map((id) => [id, lastOnlineOf(id)])) };
    },
    'updateLastOnline.php'(req, { body }) {
      const uid = requireAuth(req);
      const u = user(uid);
      u.lastOnline = nowIso(); u.visible = String(body.visible) !== '0'; u.timezone = String(body.timezone || '').slice(0, 64) || null;
      db.touch('users'); return { success: true };
    },
    'profileValueCache.php'() { return {}; },
    'profileValueSubmit.php'() { return ok; },

    // ----- playtime -----
    'postTimePlayed.php'(req, { query }) {
      const uid = requireAuth(req);
      const universeId = int(query.universeid), minutes = Math.min(int(query.minutes) || 0, 6000);
      if (!universeId || minutes <= 0) return 'error';
      const key = query.idem ? uid + ':' + String(query.idem).slice(0, 36) : null;
      if (key && idem[key]) return ok;
      const rec = ((playtime[uid] = playtime[uid] || {})[universeId] = playtime[uid][universeId] || {});
      rec[dayIndex()] = (rec[dayIndex()] || 0) + minutes;
      if (key) { idem[key] = Date.now(); db.touch('idempotency'); }
      db.touch('playtime');
      if (!games[universeId]) refreshUniverses([universeId]).catch(() => {});
      return ok;
    },
    'getPlayTime.php'(req, { query }) {
      const uid = requireAuth(req);
      const m = minutesFor(uid, int(query.universeid), int(query.time) ?? 30);
      return m > 0 ? [{ time_played: m }] : [];
    },
    'getMostPlayedUniverse.php'(req, { query }) {
      const uid = requireAuth(req);
      const days = int(query.time) ?? 30;
      return Object.keys(playtime[uid] || {})
        .map((u) => ({ id: int(u), time_played: minutesFor(uid, u, days) }))
        .filter((r) => r.time_played > 0).sort((a, b) => b.time_played - a.time_played).slice(0, 20);
    },

    // ----- experiences / discover -----
    async 'getGameCacheRefreshStatus.php'(req, { query }) {
      const placeId = int(query.placeId);
      if (!placeId) return { needsRefresh: false };
      const universeId = await universeForPlace(placeId);
      const g = universeId && games[universeId];
      if (universeId && (!g || Date.now() - g.updated > 3600000)) refreshUniverses([universeId]).catch(() => {});
      return { needsRefresh: false, universeId: universeId || null };
    },
    async 'upsertGameCacheFromClient.php'(req, { body }) {
      // Client-submitted data isn't trusted; just refresh that game from rokori.
      const placeId = int(pick(body, 'placeId', 'placeid'));
      const universeId = placeId && await universeForPlace(placeId);
      if (universeId) await refreshUniverses([universeId]).catch(() => {});
      return { ok: true };
    },
    'getExperiencesList.php'(req, { query }) {
      const page = Math.max(0, int(query.page) || 0), size = 30;
      let list = Object.values(games);
      if (String(query.order || '').toLowerCase().includes('random')) {
        let s = int(query.seed) || 1; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
        list = list.map((g) => [r(), g]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      } else list = sortGames(list, query.order);
      return list.slice(page * size, page * size + size).map((g) => ({ id: g.id, place_id: g.rootPlaceId, name: g.name, thumbnail: g.thumbnail, likes: votePct(g), active: g.playing }));
    },
    'getCachedGenreGames.php'(req, { query }) {
      const genre = String(query.genre || '').toLowerCase(), sub = String(query.subgenre || '').toLowerCase();
      if (!genre) return { error: 'genre_required' };
      let list = Object.values(games).filter((g) => {
        const g1 = String(g.genre_l1 || g.genre || '').toLowerCase(), g2 = String(g.genre_l2 || '').toLowerCase();
        return (genre === 'all' || g1 === genre) && (!sub || sub === 'all' || g2 === sub);
      });
      list = sortGames(list, query.sort);
      const offset = Math.max(0, int(query.offset) || 0), limit = Math.min(500, Math.max(1, int(query.limit) || 100));
      return { data: list.slice(offset, offset + limit).map((g) => Object.assign({}, g, { votePercent: votePct(g) })), totalCount: list.length };
    },
    'getMerch.php'() { return ''; },

    // ----- servers / invites -----
    'getServerCursor.php'() { return { cursor: '', bounds: [0, 0] }; },
    'getGlobalServerLocations.php'() { return {}; },
    'getServerLocations.php'() { return {}; },
    'getServerConnectionScore.php'() { return {}; },
    'getServerAge.php'() { return {}; },
    'postGameJoinTelemetry.php'() { return { ok: true }; },
    async 'createInvite.php'(req, { query }) {
      requireAuth(req);
      const universeId = int(query.universeid), jobid = String(query.serverid || '').replace(/[^0-9a-z-]/gi, '').slice(0, 64);
      if (!universeId || !jobid) return 'Error creating link';
      let placeid = games[universeId] && games[universeId].rootPlaceId;
      if (!placeid) { await refreshUniverses([universeId]).catch(() => {}); placeid = games[universeId] && games[universeId].rootPlaceId; }
      if (!placeid) return 'Error creating link';
      let key; do { key = crypto.randomBytes(4).toString('base64url').replace(/[^0-9a-z]/gi, '').toLowerCase().slice(0, 6); } while (key.length < 6 || invites[key]);
      invites[key] = { placeid, jobid, universeid: universeId, created: Date.now() }; db.touch('invites');
      return `${config.rokoriOrigin}/games/${placeid}#ropro-invite=${key}`;
    },
    'getInvite.php'(req, { query }) {
      const inv = invites[String(query.key || '').slice(0, 6)];
      return inv ? { placeid: inv.placeid, jobid: inv.jobid, universeid: inv.universeid } : null;
    },
    'getDiscordID.php'() { return ''; },

    // ----- support -----
    'submitBugReport.php'(req, { body }) { return saveReport('bug', req, body); },
    'submitFeatureRequest.php'(req, { body }) { return saveReport('feature', req, body); },

    // ----- paid-tier operations (never sent on the free tier; answered safely) -----
    'tradePreviewBackend.php'() { return {}; }, 'tradeProtectionBackend.php'() { return {}; },
    'itemInfoBackend.php'() { return {}; }, 'tradeBackend.php'() { return {}; },
    'getWishlistAll.php'() { return []; }, 'postWishlist.php'() { return 'error'; }, 'deleteWish.php'() { return 'error'; },
    'getWishlistAssets.php'() { return []; }, 'setWishlistAsset.php'() { return 'error'; },
    'itemSearch.php'() { return []; }, 'getItemSearch.php'() { return []; },
    'fetchFlag.php'() { return 0; }, 'fetchFlags.php'() { return []; }, 'batchFlags.php'() { return []; }, 'flagTrader.php'() { return 'error'; },
    'additionalItemInfo.php'() { return {}; }, 'tradeLogicBackend.php'() { return {}; },
    'createOutfit.php'() { return 'error'; }, 'updateOutfitThumbnail.php'() { return 'error'; }, 'deleteOutfit.php'() { return 'error'; }, 'loadOutfits.php'() { return []; },
    'getAvatarEditorBackgrounds.php'() { return []; }, 'getAssetThumbnailUrl.php'() { return ''; }, 'getDecalImage.php'() { return ''; },
    'getEggCollection.php'() { return { data: [], metadata: { numEggs: 0, visible: false }, disabled: true }; },
  };

  function saveReport(kind, req, body) {
    const id = kind.toUpperCase().slice(0, 1) + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const clean = {}; for (const [k, v] of Object.entries(body || {})) clean[k] = String(v).slice(0, 5000);
    reports[id] = { kind, userId: authUser(req), at: nowIso(), body: clean }; db.touch('reports');
    return { status: 'success', report_id: id };
  }

  return H;
}

module.exports = { makeHandlers };

'use strict';
// Client for rokori's public (Roblox-compatible) API, with a small TTL cache.

class Rokori {
  constructor(origin) {
    this.origin = origin.replace(/\/$/, '');
    this.cache = new Map();
  }
  async get(path, ttlMs = 60000) {
    const hit = this.cache.get(path);
    if (hit && hit.exp > Date.now()) return hit.val;
    const res = await fetch(this.origin + path, { headers: { 'Accept': 'application/json', 'User-Agent': 'ropro-rokori-api' } });
    if (!res.ok) throw new Error('rokori ' + res.status + ' ' + path);
    const val = await res.json();
    if (ttlMs > 0) this.cache.set(path, { val, exp: Date.now() + ttlMs });
    if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value);
    return val;
  }
  user(id, fresh = false) { return this.get('/v1/users/' + Number(id), fresh ? 0 : 5 * 60000); }
  universeForPlace(placeId) { return this.get('/universes/v1/places/' + Number(placeId) + '/universe', 24 * 3600000); }
  games(universeIds) { return this.get('/v1/games?universeIds=' + universeIds.map(Number).join(','), 5 * 60000); }
  placeDetails(placeIds) { return this.get('/v1/games/multiget-place-details?placeIds=' + placeIds.map(Number).join(','), 10 * 60000); }
  async gameIcons(universeIds) {
    try { return await this.get('/v1/games/icons?universeIds=' + universeIds.map(Number).join(',') + '&size=512x512&format=Png&isCircular=false', 30 * 60000); }
    catch (e) { return { data: [] }; }
  }
}

module.exports = { Rokori };

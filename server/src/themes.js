'use strict';
// Theme catalog relay. RoPro's public theme catalogs are fetched without any user identity, held in
// memory for a short time and passed through, so users see RoPro's real, current theme pack. The
// theme images and theme frames are loaded by the browser directly from RoPro's own servers; nothing
// of RoPro's is stored on this server. If RoPro can't be reached, the catalogs are simply empty.

const ROPRO_API = 'https://api.ropro.io';

class Themes {
  constructor(opts = {}) {
    this.ttl = (opts.cacheMinutes || 60) * 60000;
    this.cache = {};
  }

  async relay(key, url) {
    const hit = this.cache[key];
    if (hit && hit.exp > Date.now()) return hit.val;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const val = await res.json();
      this.cache[key] = { val, exp: Date.now() + this.ttl };
      return val;
    } catch (e) {
      return hit ? hit.val : null; // last good copy within this process, else nothing
    }
  }

  async themesV2() {
    const v = await this.relay('v2', ROPRO_API + '/getThemesV2.json?1=');
    return v && Array.isArray(v.themes) ? v : { themes: [] };
  }
  async videoThemesV2() {
    const v = await this.relay('video', ROPRO_API + '/getVideoThemesV2.json');
    return v && Array.isArray(v.themes) ? v : { themes: [] };
  }
  async defaultThemes() {
    const v = await this.relay('default', ROPRO_API + '/getDefaultThemes.php');
    return Array.isArray(v) ? v : [];
  }

  // Theme frames are RoPro's own pages; send the browser there.
  frameRedirect(query, video) {
    const qs = new URLSearchParams(query).toString();
    return ROPRO_API + (video ? '/themeFrameVideo.php' : '/themeFrame.php') + (qs ? '?' + qs : '');
  }
}

module.exports = { Themes };

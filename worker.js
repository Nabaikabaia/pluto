// ============================================
// 🇺🇸 PLUTO TV API v3.6 — FULL
// Cloudflare Worker
// ============================================

let cachedBoot = null;
let cachedBootTime = 0;
const CACHE_DURATION = 7 * 60 * 60 * 1000;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        }
      });
    }

    const routes = {
      "/": () => apiDocs(),
      "/channels": () => getChannels(),
      "/channel": () => getChannel(url.searchParams),
      "/categories": () => getCategories(),
      "/epg": () => getEPG(),
      "/search": () => searchChannels(url.searchParams.get("q")),
      "/stream": () => getStreamUrl(url.searchParams),
      "/play": () => proxyStream(url, request),
      "/watch": () => watchPage(url.searchParams),
      "/boot": () => getBootData(),
      "/token": () => getToken(),
    };

    const handler = routes[path];
    if (!handler) {
      return jsonResponse({ error: "Not found", endpoints: Object.keys(routes) }, 404);
    }

    try {
      return await handler();
    } catch (e) {
      return jsonResponse({ error: e.message, stack: e.stack }, 500);
    }
  }
};

// ============================================
// 🎬 WATCH PAGE
// ============================================
function watchPage(params) {
  const slug = params.get("slug") || "pluto-tv-movies-gb-1";
  const origin = "https://pluto.nabaikabaiaguo.workers.dev";

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pluto TV - ${slug}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;display:flex;justify-content:center;align-items:center;height:100vh}
video{width:100%;max-width:1280px;max-height:100vh}
#status{color:#fff;font-family:monospace;font-size:18px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}
</style>
</head>
<body>
<div id="status">🎬 Loading...</div>
<video id="v" controls autoplay playsinline style="display:none"></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
<script>
const v = document.getElementById('v');
const s = document.getElementById('status');
const url = '${origin}/play?slug=${slug}';

function fail(msg) {
  s.innerHTML = '❌ ' + msg + '<br><br><small>Try VLC: Media > Open Network Stream ><br>' + url + '</small>';
}

if (Hls.isSupported()) {
  const h = new Hls({ debug: false });
  h.loadSource(url);
  h.attachMedia(v);
  h.on(Hls.Events.MANIFEST_PARSED, () => {
    s.style.display = 'none';
    v.style.display = 'block';
    v.play().catch(() => { v.style.display = 'block'; s.style.display = 'none'; });
  });
  h.on(Hls.Events.ERROR, (e, d) => {
    console.error('HLS:', d);
    if (d.fatal) {
      switch(d.type) {
        case Hls.ErrorTypes.NETWORK_ERROR: fail('Network error - stream may be blocked'); break;
        case Hls.ErrorTypes.MEDIA_ERROR: fail('Media error - retrying...'); h.recoverMediaError(); break;
        default: fail('Stream error: ' + d.details); break;
      }
    }
  });
} else if (v.canPlayType('application/vnd.apple.mpegurl')) {
  v.src = url;
  v.addEventListener('loadedmetadata', () => { s.style.display = 'none'; v.style.display = 'block'; });
  v.addEventListener('error', () => fail('Video load failed'));
} else {
  fail('Browser not supported. Use VLC or Chrome.');
}
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

// ============================================
// GET BOOT DATA
// ============================================
async function getBootData() {
  const now = Date.now();
  if (cachedBoot && (now - cachedBootTime) < CACHE_DURATION) {
    return jsonResponse({ source: "cache", ...cachedBoot });
  }

  const clientID = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const bootUrl = `https://boot.pluto.tv/v4/start?appName=web&appVersion=9.21.0-bf9f5b4369933742859f3b2581c935110922f642&deviceVersion=148.0.7778&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${clientID}&clientModelNumber=1.0.0&serverSideAds=false&clientTime=${encodeURIComponent(timestamp)}`;

  const response = await fetch(bootUrl, {
    cf: { colo: "LAX" },
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
      "Origin": "https://pluto.tv",
      "Referer": "https://pluto.tv/",
    }
  });

  if (!response.ok) throw new Error(`Boot API: ${response.status}`);
  const data = await response.json();

  cachedBoot = {
    sessionToken: data.sessionToken,
    stitcher: data.servers?.stitcher,
    session: data.session,
    epg: data.EPG,
    refreshInSec: data.refreshInSec,
  };
  cachedBootTime = now;

  return jsonResponse({ source: "fresh", ...cachedBoot });
}

// ============================================
// GET ALL CHANNELS
// ============================================
async function getChannels() {
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = (Array.isArray(data) ? data : data.data || []).map(ch => ({
    id: ch._id,
    name: ch.name,
    slug: ch.slug,
    number: ch.number,
    category: ch.category,
    thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
    logo: ch.logo?.path || "",
    playUrl: `/play?slug=${ch.slug}`,
    watchUrl: `/watch?slug=${ch.slug}`,
    nowPlaying: ch.currentBroadcast?.title || null,
  }));
  return jsonResponse({ total: channels.length, channels }, 200, 300);
}

// ============================================
// GET TOKEN
// ============================================
async function getToken() {
  const boot = await getBootDataFromCache();
  if (!boot.sessionToken) return jsonResponse({ error: "No token" }, 500);
  return jsonResponse({ sessionToken: boot.sessionToken, expiresIn: boot.refreshInSec, country: boot.session?.country });
}

// ============================================
// GET STREAM URL
// ============================================
async function getStreamUrl(params) {
  const slug = params.get("slug");
  if (!slug) return jsonResponse({ error: "Missing ?slug=" }, 400);

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const ch = channels.find(c => c.slug === slug);
  if (!ch) return jsonResponse({ error: "Channel not found" }, 404);

  const streamUrl = buildStreamUrl(ch);
  return jsonResponse({
    channel: ch.name,
    slug: ch.slug,
    streamUrl,
    playUrl: `/play?slug=${ch.slug}`,
    watchUrl: `/watch?slug=${ch.slug}`,
    thumbnail: ch.tile?.path || "",
    logo: ch.logo?.path || "",
  });
}

// ============================================
// 🎬 STREAM PROXY
// ============================================
async function proxyStream(url, request) {
  const slug = url.searchParams.get("slug");
  const directUrl = url.searchParams.get("url");

  if (directUrl) {
    return proxyMediaFile(directUrl, request);
  }

  if (!slug) {
    return jsonResponse({ error: "Missing ?slug= or ?url=" }, 400);
  }

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const ch = channels.find(c => c.slug === slug);
  if (!ch) return jsonResponse({ error: "Channel not found" }, 404);

  const masterUrl = buildStreamUrl(ch);
  const baseUrl = new URL(request.url).origin;

  const response = await fetch(masterUrl, {
    cf: { colo: "LAX" },
    headers: getStitcherHeaders(),
  });

  if (!response.ok) {
    return new Response(`Stream error: ${response.status}`, { status: response.status });
  }

  let text = await response.text();
  text = text.replace(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/(https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/(https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);

  return new Response(text, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    }
  });
}

// ============================================
// PROXY MEDIA FILES
// ============================================
async function proxyMediaFile(targetUrl, request) {
  const response = await fetch(targetUrl, {
    cf: { colo: "LAX" },
    headers: getStitcherHeaders(),
  });

  if (!response.ok) {
    return new Response(`Error: ${response.status}`, { status: response.status });
  }

  const body = await response.arrayBuffer();
  let ct = response.headers.get("content-type") || "";
  if (!ct) {
    if (targetUrl.includes(".m3u8")) ct = "application/vnd.apple.mpegurl";
    else if (targetUrl.includes(".ts")) ct = "video/mp2t";
    else ct = "application/octet-stream";
  }

  if (targetUrl.includes(".m3u8") || ct.includes("mpegurl")) {
    const baseUrl = new URL(request.url).origin;
    let text = new TextDecoder().decode(body);
    text = text.replace(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
    text = text.replace(/(https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
    text = text.replace(/(https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
    const enc = new TextEncoder().encode(text);
    return new Response(enc, {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache", "Content-Length": enc.byteLength }
    });
  }

  return new Response(body, {
    headers: { "Content-Type": ct, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=10", "Content-Length": body.byteLength }
  });
}

// ============================================
// OTHER ENDPOINTS
// ============================================
async function getChannel(params) {
  const slug = params.get("slug");
  if (!slug) return jsonResponse({ error: "Missing ?slug=" }, 400);
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const ch = channels.find(c => c.slug === slug);
  if (!ch) return jsonResponse({ error: "Not found" }, 404);
  return jsonResponse({
    id: ch._id, name: ch.name, slug: ch.slug, number: ch.number,
    category: ch.category, description: ch.summary || "",
    thumbnail: ch.tile?.path || "", logo: ch.logo?.path || "",
    playUrl: `/play?slug=${ch.slug}`, watchUrl: `/watch?slug=${ch.slug}`,
    nowPlaying: ch.currentBroadcast?.title || null,
  }, 200, 60);
}

async function getCategories() {
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const cats = [...new Set(channels.map(c => c.category))].sort();
  return jsonResponse({ total: cats.length, categories: cats }, 200, 600);
}

async function getEPG() {
  const boot = await getBootDataFromCache();
  if (!boot.epg?.length) return jsonResponse({ error: "No EPG" }, 404);
  const programs = boot.epg.flatMap(ch => (ch.timelines || []).map(t => ({
    channelName: ch.name, channelSlug: ch.slug, channelNumber: ch.number,
    title: t.title, startTime: t.start, endTime: t.stop,
    genre: t.episode?.genre, rating: t.episode?.rating, description: t.episode?.description,
  })));
  return jsonResponse({ total: programs.length, programs }, 200, 120);
}

async function searchChannels(query) {
  if (!query) return jsonResponse({ error: "Missing ?q=" }, 400);
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const q = query.toLowerCase();
  const results = channels.filter(c => c.name?.toLowerCase().includes(q) || c.category?.toLowerCase().includes(q)).slice(0, 30).map(c => ({
    id: c._id, name: c.name, slug: c.slug, number: c.number, category: c.category,
    thumbnail: c.tile?.path || "", logo: c.logo?.path || "",
    playUrl: `/play?slug=${c.slug}`, watchUrl: `/watch?slug=${c.slug}`,
  }));
  return jsonResponse({ query, total: results.length, results }, 200, 120);
}

// ============================================
// HELPERS
// ============================================
function buildStreamUrl(channel) {
  const stitcher = cachedBoot?.stitcher || "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
  const q = new URLSearchParams({
    advertisingId: "", appName: "web", appVersion: "9.21.0-bf9f5b4369933742859f3b2581c935110922f642",
    architecture: "", buildVersion: "", clientTime: new Date().toISOString(),
    deviceDNT: "false", deviceId: crypto.randomUUID(), deviceLat: "34.0522", deviceLon: "-118.2437",
    deviceMake: "chrome", deviceModel: "web", deviceType: "web", deviceVersion: "148.0.7778",
    includeExtendedEvents: "false", marketingRegion: "US", serverSideAds: "false",
    sid: crypto.randomUUID(), sessionID: crypto.randomUUID(), userId: "",
  });
  return `${stitcher}/stitch/hls/channel/${channel._id}/master.m3u8?${q.toString()}`;
}

function getStitcherHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*", "Origin": "https://pluto.tv", "Referer": "https://pluto.tv/",
    "plutotv-device-dnt": "false", "plutotv-device-model": "web",
    "plutotv-device-make": "chrome", "plutotv-device-type": "web",
    "plutotv-device-version": "148.0.7778", "plutotv-app-name": "web",
    "plutotv-app-version": "9.21.0",
  };
}

async function getBootDataFromCache() {
  const now = Date.now();
  if (cachedBoot && (now - cachedBootTime) < CACHE_DURATION) return cachedBoot;
  const clientID = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const bootUrl = `https://boot.pluto.tv/v4/start?appName=web&appVersion=9.21.0-bf9f5b4369933742859f3b2581c935110922f642&deviceVersion=148.0.7778&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${clientID}&clientModelNumber=1.0.0&serverSideAds=false&clientTime=${encodeURIComponent(timestamp)}`;
  const r = await fetch(bootUrl, {
    cf: { colo: "LAX" },
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Origin": "https://pluto.tv", "Referer": "https://pluto.tv/" }
  });
  const d = await r.json();
  cachedBoot = { sessionToken: d.sessionToken, stitcher: d.servers?.stitcher, session: d.session, epg: d.EPG, refreshInSec: d.refreshInSec };
  cachedBootTime = now;
  return cachedBoot;
}

async function plutoFetch(endpoint) {
  const r = await fetch(`https://api.pluto.tv${endpoint}`, {
    cf: { colo: "LAX" },
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Origin": "https://pluto.tv", "Referer": "https://pluto.tv/" }
  });
  return r.json();
}

function apiDocs() {
  return jsonResponse({
    service: "Pluto TV API v3.6 🎬",
    endpoints: {
      "/channels": "All live channels",
      "/channel?slug=cnn": "Channel details",
      "/categories": "Categories",
      "/epg": "Program guide",
      "/search?q=comedy": "Search",
      "/stream?slug=cnn": "Stream URL",
      "/play?slug=cnn": "Proxied m3u8 (for VLC)",
      "/watch?slug=cnn": "🎬 Web player!",
      "/token": "JWT token",
      "/boot": "Boot data",
    }
  });
}

function jsonResponse(data, status = 200, maxAge = 60) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": `public, max-age=${maxAge}` }
  });
}

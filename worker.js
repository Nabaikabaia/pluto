// ============================================
// 🇺🇸 PLUTO TV API v7.0 — RENDER TOKEN
// ============================================

const RENDER_URL = "https://pluto-proxy.onrender.com";

let cachedToken = null;
let cachedTokenTime = 0;
const TOKEN_CACHE = 5 * 60 * 60 * 1000;

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
      "/token": () => getTokenInfo(),
    };

    const handler = routes[path];
    if (!handler) {
      return jsonResponse({ error: "Not found", endpoints: Object.keys(routes) }, 404);
    }

    try {
      return await handler();
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

// ============================================
// FETCH TOKEN FROM RENDER
// ============================================
async function getUSToken() {
  const now = Date.now();
  if (cachedToken && (now - cachedTokenTime) < TOKEN_CACHE) return cachedToken;

  const response = await fetch(`${RENDER_URL}/token`, {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Render error ${response.status}: ${text.slice(0, 100)}`);
  }

  const data = await response.json();
  
  cachedToken = {
    sessionToken: data.sessionToken,
    stitcher: data.stitcher || "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv",
    country: data.session?.countryCode || data.session?.country || "unknown",
  };
  cachedTokenTime = now;
  
  return cachedToken;
}

// ============================================
// TOKEN INFO
// ============================================
async function getTokenInfo() {
  try {
    const token = await getUSToken();
    return jsonResponse({ country: token.country, stitcher: token.stitcher, hasToken: !!token.sessionToken });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ============================================
// GET ALL CHANNELS
// ============================================
async function getChannels() {
  await getUSToken(); // Ensure token is loaded
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = (Array.isArray(data) ? data : data.data || []).map(ch => ({
    id: ch._id, name: ch.name, slug: ch.slug, number: ch.number,
    category: ch.category, description: ch.summary || "",
    thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
    logo: ch.logo?.path || "",
    playUrl: `/play?slug=${ch.slug}`,
    watchUrl: `/watch?slug=${ch.slug}`,
  }));
  return jsonResponse({ total: channels.length, country: cachedToken?.country, channels }, 200, 300);
}

// ============================================
// GET SINGLE CHANNEL
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
    category: ch.category, thumbnail: ch.tile?.path || "", logo: ch.logo?.path || "",
    playUrl: `/play?slug=${ch.slug}`, watchUrl: `/watch?slug=${ch.slug}`,
  }, 200, 60);
}

// ============================================
// GET CATEGORIES
// ============================================
async function getCategories() {
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const cats = [...new Set(channels.map(c => c.category))].sort();
  return jsonResponse({ total: cats.length, categories: cats }, 200, 600);
}

// ============================================
// GET EPG
// ============================================
async function getEPG() {
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const programs = channels.map(ch => ({
    channelName: ch.name, channelSlug: ch.slug, channelNumber: ch.number,
    category: ch.category, playUrl: `/play?slug=${ch.slug}`, watchUrl: `/watch?slug=${ch.slug}`,
  }));
  return jsonResponse({ total: programs.length, programs }, 200, 120);
}

// ============================================
// SEARCH
// ============================================
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
// GET STREAM URL
// ============================================
async function getStreamUrl(params) {
  const slug = params.get("slug");
  if (!slug) return jsonResponse({ error: "Missing ?slug=" }, 400);
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const ch = channels.find(c => c.slug === slug);
  if (!ch) return jsonResponse({ error: "Not found" }, 404);
  const streamUrl = buildStreamUrl(ch);
  return jsonResponse({ channel: ch.name, slug: ch.slug, streamUrl, playUrl: `/play?slug=${ch.slug}` });
}

// ============================================
// 🎬 STREAM PROXY
// ============================================
async function proxyStream(url, request) {
  const slug = url.searchParams.get("slug");
  const directUrl = url.searchParams.get("url");
  if (directUrl) return proxyMediaFile(directUrl, request);
  if (!slug) return jsonResponse({ error: "Missing ?slug= or ?url=" }, 400);

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const ch = channels.find(c => c.slug === slug);
  if (!ch) return jsonResponse({ error: "Not found" }, 404);

  const masterUrl = buildStreamUrl(ch);
  const baseUrl = new URL(request.url).origin;
  const masterBase = masterUrl.replace(/\/master\.m3u8.*$/, '');

  const response = await fetch(masterUrl, {
    cf: { colo: "LAX" },
    headers: getStitcherHeaders(),
  });

  if (!response.ok) return new Response(`Stream error: ${response.status}`, { status: response.status });

  let text = await response.text();
  text = rewriteUrls(text, masterBase, baseUrl);

  return new Response(text, {
    headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" }
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
  if (!response.ok) return new Response(`Error: ${response.status}`, { status: response.status });

  const body = await response.arrayBuffer();
  let ct = response.headers.get("content-type") || "";
  if (!ct) {
    if (targetUrl.includes(".m3u8")) ct = "application/vnd.apple.mpegurl";
    else if (targetUrl.includes(".ts")) ct = "video/mp2t";
    else ct = "application/octet-stream";
  }

  if (targetUrl.includes(".m3u8") || ct.includes("mpegurl")) {
    const baseUrl = new URL(request.url).origin;
    const targetBase = targetUrl.replace(/\/[^\/]+\.m3u8.*$/, '');
    let text = new TextDecoder().decode(body);
    text = rewriteUrls(text, targetBase, baseUrl);
    const enc = new TextEncoder().encode(text);
    return new Response(enc, {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" }
    });
  }

  return new Response(body, {
    headers: { "Content-Type": ct, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=10" }
  });
}

// ============================================
// 🎬 WATCH PAGE
// ============================================
function watchPage(params) {
  const slug = params.get("slug") || "cnn-headlines";
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pluto TV - ${slug}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column}
video{width:100%;max-width:1280px;max-height:80vh}
#s{color:#fff;font-family:monospace;font-size:18px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}
#c{margin-top:20px;display:none}
a{color:#fff;background:#e50914;padding:12px 24px;border-radius:8px;text-decoration:none;font-family:monospace;font-size:16px;margin:10px}
</style>
</head>
<body>
<div id="s">🎬 Loading ${slug}...</div>
<video id="v" controls autoplay playsinline style="display:none"></video>
<div id="c"><a href="/channels">📺 Channels</a><a href="/watch?slug=${slug}" style="background:#333">🔄 Reload</a></div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<script>
const v=document.getElementById('v'),s=document.getElementById('s'),c=document.getElementById('c'),u='/play?slug=${slug}';
function f(m){s.innerHTML='❌ '+m+'<br><small>VLC: '+u+'</small>';c.style.display='block'}
if(Hls.isSupported()){const h=new Hls({debug:false});h.loadSource(u);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>{s.style.display='none';v.style.display='block';c.style.display='block';v.play().catch(()=>{})});h.on(Hls.Events.ERROR,(e,d)=>{console.error(d);if(d.fatal)f('Error: '+d.details)})}
else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src=u;v.addEventListener('loadedmetadata',()=>{s.style.display='none';v.style.display='block';c.style.display='block'})}
else f('Use Chrome or VLC')
</script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ============================================
// HELPERS
// ============================================
function buildStreamUrl(channel) {
  const stitcher = cachedToken?.stitcher || "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
  const deviceId = crypto.randomUUID();
  const sid = crypto.randomUUID();
  const ts = new Date().toISOString();

  const q = new URLSearchParams({
    advertisingId: "", appName: "web", appVersion: "9.21.0-bf9f5b4369933742859f3b2581c935110922f642",
    architecture: "", buildVersion: "", clientTime: ts,
    deviceDNT: "false", deviceId, deviceLat: "34.0522", deviceLon: "-118.2437",
    deviceMake: "chrome", deviceModel: "web", deviceType: "web", deviceVersion: "148.0.7778",
    includeExtendedEvents: "false", marketingRegion: "US", serverSideAds: "false",
    sid, sessionID: sid, userId: "",
  });

  return `${stitcher}/stitch/hls/channel/${channel._id}/master.m3u8?${q.toString()}`;
}

function getStitcherHeaders() {
  const h = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*", "Origin": "https://pluto.tv", "Referer": "https://pluto.tv/",
    "plutotv-device-dnt": "false", "plutotv-device-model": "web",
    "plutotv-device-make": "chrome", "plutotv-device-type": "web",
    "plutotv-device-version": "148.0.7778", "plutotv-app-name": "web",
    "plutotv-app-version": "9.21.0",
  };
  if (cachedToken?.sessionToken) {
    h["Authorization"] = `Bearer ${cachedToken.sessionToken}`;
  }
  return h;
}

function rewriteUrls(text, targetBase, baseUrl) {
  text = text.replace(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.m3u8[^\s"'<>]*/gim, match => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${match}`)}`);
  text = text.replace(/URI="(?!https?:\/\/)([^"]+)"/gi, (m, path) => `URI="${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${path}`)}"`);
  return text;
}

async function plutoFetch(endpoint) {
  const h = { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Origin": "https://pluto.tv", "Referer": "https://pluto.tv/" };
  if (cachedToken?.sessionToken) {
    h["Authorization"] = `Bearer ${cachedToken.sessionToken}`;
  }
  const r = await fetch(`https://api.pluto.tv${endpoint}`, { cf: { colo: "LAX" }, headers: h });
  return r.json();
}

function apiDocs() {
  return jsonResponse({
    service: "Pluto TV API v7.0 🇺🇸",
    endpoints: {
      "/channels": "All channels",
      "/channel?slug=cnn": "Channel details",
      "/categories": "Categories",
      "/epg": "Program guide",
      "/search?q=comedy": "Search",
      "/stream?slug=cnn": "Stream URL",
      "/play?slug=cnn": "🎬 Stream (VLC)",
      "/watch?slug=cnn": "🎬 Watch (Browser)",
      "/token": "Token info",
    }
  });
}

function jsonResponse(data, status = 200, maxAge = 60) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": `public, max-age=${maxAge}` }
  });
}

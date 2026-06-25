// ============================================
// PLUTO TV PROXY RELAY v4 — FULL
// Deploy on Render, Region: US (Oregon)
// ============================================

const express = require("express");
const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());

let usProxies = [];
let currentProxy = null;
let lastProxyFetch = 0;
let lastProxyRotate = 0;
const PROXY_FETCH_INTERVAL = 10 * 60 * 1000;
const PROXY_ROTATE_INTERVAL = 5 * 60 * 1000;

// ============================================
// FETCH US PROXIES
// ============================================
async function fetchUSProxies() {
  const now = Date.now();
  if (usProxies.length > 0 && (now - lastProxyFetch) < PROXY_FETCH_INTERVAL) {
    return usProxies;
  }
  try {
    const response = await fetch("https://proxies.gifted.co.ke/files/countries/US.json");
    const data = await response.json();
    usProxies = data.proxies || [];
    lastProxyFetch = now;
    console.log(`✅ Fetched ${usProxies.length} US proxies`);
    return usProxies;
  } catch (e) {
    console.error("Proxy fetch failed:", e.message);
    return usProxies;
  }
}

// ============================================
// GET WORKING US PROXY
// ============================================
async function getWorkingProxy() {
  const now = Date.now();
  if (currentProxy && (now - lastProxyRotate) < PROXY_ROTATE_INTERVAL) {
    return currentProxy;
  }

  const proxies = await fetchUSProxies();
  const shuffled = proxies.filter(p => p.countryCode === "US").sort(() => Math.random() - 0.5);

  for (const proxy of shuffled.slice(0, 20)) {
    try {
      const agent = createAgent(proxy);
      const testRes = await fetch("https://api.pluto.tv/v2/channels?channelType=live&limit=2", {
        agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Origin": "https://pluto.tv",
          "Referer": "https://pluto.tv/",
        },
        timeout: 6000,
      });

      if (testRes.ok) {
        const data = await testRes.json();
        const channels = Array.isArray(data) ? data : data.data || [];
        if (channels.length > 0) {
          currentProxy = proxy;
          lastProxyRotate = now;
          console.log(`✅ Proxy: ${proxy.query}:${proxy.port} → ${channels[0]?.name}`);
          return proxy;
        }
      }
    } catch (e) {}
  }

  console.log("⚠️ No working proxy, using direct connection");
  return null;
}

// ============================================
// CREATE PROXY AGENT
// ============================================
function createAgent(proxy) {
  const type = proxy.type || "http";
  const url = `${type}://${proxy.query}:${proxy.port}`;
  if (type === "socks4" || type === "socks5") {
    return new SocksProxyAgent(url);
  }
  return new HttpsProxyAgent(url);
}

// ============================================
// SMART FETCH — DIRECT FALLBACK
// ============================================
async function proxyFetch(url, options = {}) {
  const fetchOptions = {
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": options.headers?.["Accept"] || "application/json",
      "Origin": "https://pluto.tv",
      "Referer": "https://pluto.tv/",
      ...options.headers,
    },
    timeout: 15000,
  };

  // Try with proxy first
  const proxy = await getWorkingProxy();
  if (proxy) {
    try {
      fetchOptions.agent = createAgent(proxy);
      const response = await fetch(url, fetchOptions);
      if (response.ok) return response;
      console.log(`⚠️ Proxy returned ${response.status}`);
    } catch (e) {
      console.log(`⚠️ Proxy ${proxy.query} failed: ${e.message}`);
    }
  }

  // FALLBACK: Direct connection using Render's IP
  console.log("🔄 Direct connection...");
  delete fetchOptions.agent;
  return fetch(url, fetchOptions);
}

// ============================================
// STITCHER HEADERS
// ============================================
function stitcherHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*",
    "Origin": "https://pluto.tv",
    "Referer": "https://pluto.tv/",
    "plutotv-device-dnt": "false",
    "plutotv-device-model": "web",
    "plutotv-device-make": "chrome",
    "plutotv-device-type": "web",
    "plutotv-device-version": "148.0.7778",
    "plutotv-app-name": "web",
    "plutotv-app-version": "9.21.0",
  };
}

// ============================================
// BUILD STREAM URL
// ============================================
function buildStreamUrl(channel) {
  const base = "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
  const q = new URLSearchParams({
    advertisingId: "",
    appName: "web",
    appVersion: "9.21.0-bf9f5b4369933742859f3b2581c935110922f642",
    architecture: "",
    buildVersion: "",
    clientTime: new Date().toISOString(),
    deviceDNT: "false",
    deviceId: uuidv4(),
    deviceLat: "34.0522",
    deviceLon: "-118.2437",
    deviceMake: "chrome",
    deviceModel: "web",
    deviceType: "web",
    deviceVersion: "148.0.7778",
    includeExtendedEvents: "false",
    marketingRegion: "US",
    serverSideAds: "false",
    sid: uuidv4(),
    sessionID: uuidv4(),
    userId: "",
  });
  return `${base}/stitch/hls/channel/${channel._id}/master.m3u8?${q.toString()}`;
}

// ============================================
// REWRITE PLAYLIST URLS
// ============================================
function rewritePlaylistUrls(text, targetBase, baseUrl) {
  // Rewrite absolute URLs (both http and https)
  text = text.replace(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  
  // Rewrite relative paths
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.m3u8[^\s"'<>]*/gim, match => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${match}`)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.ts[^\s"'<>]*/gim, match => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${match}`)}`);
  
  // Rewrite URI= attributes with relative paths
  text = text.replace(/URI="(?!https?:\/\/)([^"]+)"/gi, (m, path) => `URI="${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${path}`)}"`);
  
  return text;
}

// ============================================
// HEALTH
// ============================================
app.get("/health", async (req, res) => {
  try {
    const testRes = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live&limit=1");
    const data = await testRes.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    res.json({
      status: "ok",
      plutoReachable: true,
      sampleChannel: channels[0]?.name || "N/A",
      sampleSlug: channels[0]?.slug || "N/A",
      uptime: process.uptime(),
    });
  } catch (e) {
    res.json({ status: "degraded", plutoReachable: false, error: e.message });
  }
});

// ============================================
// CHANNELS
// ============================================
app.get("/channels", async (req, res) => {
  try {
    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = (Array.isArray(data) ? data : data.data || []).map(ch => ({
      id: ch._id,
      name: ch.name,
      slug: ch.slug,
      number: ch.number,
      category: ch.category,
      description: ch.summary || "",
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
      logo: ch.logo?.path || "",
      playUrl: `/play?slug=${ch.slug}`,
      watchUrl: `/watch?slug=${ch.slug}`,
    }));
    res.json({ total: channels.length, channels });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SINGLE CHANNEL
// ============================================
app.get("/channel", async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });
  try {
    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    const ch = channels.find(c => c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Channel not found" });
    res.json({
      id: ch._id,
      name: ch.name,
      slug: ch.slug,
      number: ch.number,
      category: ch.category,
      description: ch.summary || "",
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
      logo: ch.logo?.path || "",
      playUrl: `/play?slug=${ch.slug}`,
      watchUrl: `/watch?slug=${ch.slug}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// CATEGORIES
// ============================================
app.get("/categories", async (req, res) => {
  try {
    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    const categories = [...new Set(channels.map(c => c.category))].sort();
    res.json({ total: categories.length, categories });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// EPG
// ============================================
app.get("/epg", async (req, res) => {
  try {
    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    const programs = channels.map(ch => ({
      channelName: ch.name,
      channelSlug: ch.slug,
      channelNumber: ch.number,
      category: ch.category,
      playUrl: `/play?slug=${ch.slug}`,
      watchUrl: `/watch?slug=${ch.slug}`,
    }));
    res.json({ total: programs.length, programs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// SEARCH
// ============================================
app.get("/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing ?q=" });
  try {
    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    const q = query.toLowerCase();
    const results = channels
      .filter(c => c.name?.toLowerCase().includes(q) || c.category?.toLowerCase().includes(q) || c.summary?.toLowerCase().includes(q))
      .slice(0, 30)
      .map(c => ({
        id: c._id,
        name: c.name,
        slug: c.slug,
        number: c.number,
        category: c.category,
        thumbnail: c.tile?.path || c.thumbnail?.path || "",
        logo: c.logo?.path || "",
        playUrl: `/play?slug=${c.slug}`,
        watchUrl: `/watch?slug=${c.slug}`,
      }));
    res.json({ query, total: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// STREAM URL
// ============================================
app.get("/stream", async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: "Missing ?slug=" });
  try {
    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    const ch = channels.find(c => c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Channel not found" });
    res.json({
      channel: ch.name,
      slug: ch.slug,
      number: ch.number,
      streamUrl: buildStreamUrl(ch),
      playUrl: `/play?slug=${ch.slug}`,
      watchUrl: `/watch?slug=${ch.slug}`,
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
      logo: ch.logo?.path || "",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// 🎬 PLAY — STREAM PROXY
// ============================================
app.get("/play", async (req, res) => {
  const slug = req.query.slug;
  const directUrl = req.query.url;
  const baseUrl = `https://${req.get("host")}`;

  try {
    // Proxy a direct URL (.m3u8, .ts, .key)
    if (directUrl) {
      const response = await proxyFetch(directUrl, { headers: stitcherHeaders() });
      if (!response.ok) return res.status(response.status).send(`Error: ${response.status}`);

      const contentType = response.headers.get("content-type") || "";
      const body = await response.buffer();

      // If it's a playlist, rewrite URLs
      if (directUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
        let text = body.toString();
        const targetBase = directUrl.replace(/\/[^\/]+\.m3u8.*$/, "");
        text = rewritePlaylistUrls(text, targetBase, baseUrl);
        res.set("Content-Type", "application/vnd.apple.mpegurl");
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Cache-Control", "no-cache");
        return res.send(text);
      }

      // Binary file (.ts, .key)
      res.set("Content-Type", contentType || "application/octet-stream");
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "public, max-age=10");
      return res.send(body);
    }

    // Get channel stream by slug
    if (!slug) return res.status(400).json({ error: "Missing ?slug= or ?url=" });

    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    const ch = channels.find(c => c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Channel not found" });

    const masterUrl = buildStreamUrl(ch);
    const masterBase = masterUrl.replace(/\/master\.m3u8.*$/, "");
    const masterRes = await proxyFetch(masterUrl, { headers: stitcherHeaders() });
    if (!masterRes.ok) return res.status(masterRes.status).send(`Stream error: ${masterRes.status}`);

    let text = await masterRes.text();
    text = rewritePlaylistUrls(text, masterBase, baseUrl);

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-cache");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ============================================
// 🎬 WATCH — WEB PLAYER
// ============================================
app.get("/watch", (req, res) => {
  const slug = req.query.slug || "cnn-headlines";
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
<div id="c">
  <a href="/channels">📺 More Channels</a>
  <a href="/watch?slug=${slug}" style="background:#333">🔄 Reload</a>
</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<script>
const v=document.getElementById('v'),s=document.getElementById('s'),c=document.getElementById('c');
const u='/play?slug=${slug}';
function f(m){s.innerHTML='❌ '+m+'<br><small>Try VLC: '+u+'</small>';c.style.display='block'}
function p(){
  if(Hls.isSupported()){
    const h=new Hls({debug:false});
    h.loadSource(u);
    h.attachMedia(v);
    h.on(Hls.Events.MANIFEST_PARSED,()=>{s.style.display='none';v.style.display='block';c.style.display='block';v.play().catch(()=>{})});
    h.on(Hls.Events.ERROR,(e,d)=>{console.error(d);if(d.fatal)f('Stream error: '+d.details)})
  }else if(v.canPlayType('application/vnd.apple.mpegurl')){
    v.src=u;
    v.addEventListener('loadedmetadata',()=>{s.style.display='none';v.style.display='block';c.style.display='block'});
    v.addEventListener('error',()=>f('Video failed'))
  }else{f('Use Chrome or VLC')}
}
p();
</script>
</body>
</html>`;
  res.set("Content-Type", "text/html");
  res.send(html);
});

// ============================================
// HOME PAGE — CHANNEL LIST
// ============================================
app.get("/", (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pluto TV — US Channels</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:Arial,sans-serif;padding:20px}
h1{text-align:center;margin:20px 0;color:#e50914}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:15px;max-width:1400px;margin:0 auto}
.card{background:#1a1a1a;border-radius:12px;padding:15px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:transform 0.2s;text-decoration:none;color:#fff}
.card:hover{transform:scale(1.02);background:#222}
.card img{width:120px;height:68px;object-fit:cover;border-radius:8px}
.card .info{flex:1}
.card .name{font-weight:bold;font-size:16px;margin-bottom:4px}
.card .meta{font-size:12px;color:#aaa}
.card .number{background:#e50914;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:6px}
#loading{text-align:center;padding:40px;font-size:18px;color:#aaa}
</style>
</head>
<body>
<h1>🇺🇸 Pluto TV — US Channels</h1>
<div id="loading">📺 Loading channels...</div>
<div class="grid" id="grid"></div>
<script>
async function load(){
  try{
    const r=await fetch('/channels');
    const d=await r.json();
    document.getElementById('loading').style.display='none';
    const g=document.getElementById('grid');
    d.channels.forEach(ch=>{
      const a=document.createElement('a');
      a.className='card';
      a.href='/watch?slug='+ch.slug;
      a.innerHTML='<img src="'+(ch.thumbnail||'')+'" onerror="this.src=\\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%2268%22><rect fill=%22%23333%22 width=%22120%22 height=%2268%22/><text fill=%22%23fff%22 x=%2260%22 y=%2238%22 text-anchor=%22middle%22 font-size=%2212%22>No Image</text></svg>\\'"><div class="info"><div class="name"><span class="number">'+ch.number+'</span>'+ch.name+'</div><div class="meta">'+ch.category+'</div></div>';
      g.appendChild(a);
    });
  }catch(e){
    document.getElementById('loading').textContent='❌ Error loading channels';
  }
}
load();
</script>
</body>
</html>`;
  res.set("Content-Type", "text/html");
  res.send(html);
});

// ============================================
// KEEP ALIVE
// ============================================
setInterval(() => {
  fetch("https://api.pluto.tv/v2/channels?channelType=live&limit=1", {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
  }).then(() => console.log("💓 Keep-alive")).catch(() => {});
}, 10 * 60 * 1000);

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Pluto Relay v4 on port ${PORT}`);
  fetchUSProxies();
});

// ============================================
// PLUTO TV US API v3.2 + VIDEO CONVERTER (GET)
// Deploy on Render, Region: US (Oregon)
// ============================================

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const API = "https://api.pluto.tv";
const BOOT = "https://boot.pluto.tv";
const STITCHER = "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
const TEMP_DIR = "/tmp";

let cache = null;
let cacheTime = 0;
let cachedJWT = null;
let cachedJWTTime = 0;
const CACHE_TTL = 30 * 60 * 1000;
const JWT_TTL = 6 * 60 * 60 * 1000;

function uid() { return uuidv4(); }
function getBaseUrl(req) { return `https://${req.get("host")}`; }

function plutoHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://pluto.tv",
    "Referer": "https://pluto.tv/",
  };
}

async function getJWT() {
  const now = Date.now();
  if (cachedJWT && (now - cachedJWTTime) < JWT_TTL) return cachedJWT;
  const clientID = uid();
  const sessionID = uid();
  const timestamp = new Date().toISOString();
  const bootUrl = `${BOOT}/v4/start?appName=web&appVersion=9.22.0-ba99318afe50de3c8a02021f4c92fd52f2c47a00&deviceVersion=149.0.7827&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${clientID}&clientModelNumber=1.0.0&serverSideAds=false&clientTime=${encodeURIComponent(timestamp)}`;
  const res = await fetch(bootUrl, { headers: plutoHeaders() });
  const data = await res.json();
  cachedJWT = { jwt: data.sessionToken, sessionID: data.session?.sessionID, deviceId: clientID, country: data.session?.countryCode };
  cachedJWTTime = now;
  console.log(`🇺🇸 JWT: ${cachedJWT.country}`);
  return cachedJWT;
}

function buildStreamUrl(id, jwt, sid, deviceId) {
  const ts = new Date().toISOString();
  const q = new URLSearchParams({ sid, deviceId, jwt, clientTime: ts, deviceDNT: "false", deviceMake: "chrome", deviceModel: "web", deviceType: "web", deviceVersion: "149.0.7827", appName: "web", appVersion: "9.22.0", serverSideAds: "false" });
  return `${STITCHER}/v2/stitch/hls/channel/${id}/master.m3u8?${q.toString()}`;
}

function rewritePlaylist(text, targetBase, baseUrl) {
  text = text.replace(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.m3u8[^\s"'<>]*/gim, m => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${m}`)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.ts[^\s"'<>]*/gim, m => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${m}`)}`);
  text = text.replace(/URI="(?!https?:\/\/)([^"]+)"/gi, (_, p) => `URI="${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${p}`)}"`);
  return text;
}

// ============================================
// PLUTO TV ENDPOINTS
// ============================================

app.get("/health", async (req, res) => {
  try {
    const jwt = await getJWT();
    const r = await fetch(`${API}/v2/channels?channelType=live&limit=1`, { headers: plutoHeaders() });
    const d = await r.json();
    const ch = (Array.isArray(d) ? d : d.data || [])[0];
    res.json({ status: "ok", country: jwt.country, channel: ch?.name, slug: ch?.slug, isUS: ch?.slug ? !ch.slug.includes("-de") && !ch.slug.includes("-gb") && !ch.slug.includes("-fr") : false });
  } catch (e) { res.json({ status: "down", error: e.message }); }
});

app.get("/channels", async (req, res) => {
  try {
    const now = Date.now();
    const baseUrl = getBaseUrl(req);
    if (cache && (now - cacheTime) < CACHE_TTL) return res.json({ source: "cache", total: cache.length, channels: cache });
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = (Array.isArray(d) ? d : d.data || []).map(ch => ({
      id: ch._id, name: ch.name, slug: ch.slug, number: ch.number, category: ch.category, description: ch.summary || "",
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "", logo: ch.logo?.path || "",
      isUS: !ch.slug?.includes("-de") && !ch.slug?.includes("-gb") && !ch.slug?.includes("-fr") && !ch.slug?.includes("-es") && !ch.slug?.includes("-it"),
      streamUrl: `${baseUrl}/stream?id=${ch._id}`, playUrl: `${baseUrl}/play?id=${ch._id}`, watchUrl: `${baseUrl}/watch?slug=${ch.slug}`,
    }));
    cache = channels; cacheTime = now;
    res.json({ total: channels.length, usTotal: channels.filter(c => c.isUS).length, channels });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/channel", async (req, res) => {
  try {
    const { slug, id } = req.query;
    const baseUrl = getBaseUrl(req);
    if (!slug && !id) return res.status(400).json({ error: "Missing slug or id" });
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const ch = channels.find(c => c.slug === slug || c._id === id);
    if (!ch) return res.status(404).json({ error: "Not found" });
    res.json({ id: ch._id, name: ch.name, slug: ch.slug, number: ch.number, category: ch.category, description: ch.summary || "", thumbnail: ch.tile?.path || "", logo: ch.logo?.path || "", streamUrl: `${baseUrl}/stream?id=${ch._id}`, playUrl: `${baseUrl}/play?id=${ch._id}`, watchUrl: `${baseUrl}/watch?slug=${ch.slug}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/categories", async (req, res) => {
  try {
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const cats = [...new Set(channels.map(c => c.category))].sort();
    res.json({ total: cats.length, categories: cats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/epg", async (req, res) => {
  try {
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const baseUrl = getBaseUrl(req);
    res.json({ total: channels.length, programs: channels.map(ch => ({ id: ch._id, name: ch.name, slug: ch.slug, number: ch.number, category: ch.category, streamUrl: `${baseUrl}/stream?id=${ch._id}`, playUrl: `${baseUrl}/play?id=${ch._id}`, watchUrl: `${baseUrl}/watch?slug=${ch.slug}` })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    if (!q) return res.status(400).json({ error: "Missing q" });
    const baseUrl = getBaseUrl(req);
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const results = channels.filter(c => c.name?.toLowerCase().includes(q) || c.category?.toLowerCase().includes(q)).slice(0, 50).map(c => ({ id: c._id, name: c.name, slug: c.slug, number: c.number, category: c.category, thumbnail: c.tile?.path || "", streamUrl: `${baseUrl}/stream?id=${c._id}`, playUrl: `${baseUrl}/play?id=${c._id}`, watchUrl: `${baseUrl}/watch?slug=${c.slug}` }));
    res.json({ query: q, total: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/stream", async (req, res) => {
  try {
    const { id, slug } = req.query;
    if (!id && !slug) return res.status(400).json({ error: "Missing id or slug" });
    const jwt = await getJWT();
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const ch = channels.find(c => c._id === id || c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Not found" });
    const streamUrl = buildStreamUrl(ch._id, jwt.jwt, jwt.sessionID, jwt.deviceId);
    res.json({ id: ch._id, name: ch.name, slug: ch.slug, streamUrl, jwtPreview: jwt.jwt?.slice(0, 50) + "..." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/play", async (req, res) => {
  try {
    const { id, slug, url: directUrl } = req.query;
    const baseUrl = getBaseUrl(req);
    if (directUrl) {
      const r = await fetch(directUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*", "Origin": "https://pluto.tv", "Referer": "https://pluto.tv/" } });
      if (!r.ok) return res.status(r.status).send(`Error: ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      const body = await r.buffer();
      if (directUrl.includes(".m3u8") || ct.includes("mpegurl")) {
        let text = body.toString();
        const targetBase = directUrl.replace(/\/[^\/]+\.m3u8.*$/, "");
        text = rewritePlaylist(text, targetBase, baseUrl);
        res.set("Content-Type", "application/vnd.apple.mpegurl");
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Cache-Control", "no-cache");
        return res.send(text);
      }
      res.set("Content-Type", ct || "application/octet-stream");
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "public, max-age=60");
      return res.send(body);
    }
    if (!id && !slug) return res.status(400).json({ error: "Missing id, slug, or url" });
    const jwt = await getJWT();
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const ch = channels.find(c => c._id === id || c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Not found" });
    const masterUrl = buildStreamUrl(ch._id, jwt.jwt, jwt.sessionID, jwt.deviceId);
    const masterBase = masterUrl.replace(/\/master\.m3u8.*$/, "");
    const mr = await fetch(masterUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*", "Origin": "https://pluto.tv" } });
    if (!mr.ok) return res.status(mr.status).send(`Stream error: ${mr.status}`);
    let text = await mr.text();
    text = rewritePlaylist(text, masterBase, baseUrl);
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-cache");
    res.send(text);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/watch", async (req, res) => {
  const { id, slug } = req.query;
  const baseUrl = getBaseUrl(req);
  const playUrl = id ? `${baseUrl}/play?id=${id}` : `${baseUrl}/play?slug=${slug || "cnn-headlines"}`;
  const channelName = slug || id || "Pluto TV";
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Pluto TV - ${channelName}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column}video{width:100%;max-width:1280px;max-height:80vh;background:#000}#status{color:#fff;font-family:monospace;font-size:18px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center}#controls{margin-top:20px;display:none}a{color:#fff;background:#e50914;padding:12px 24px;border-radius:8px;text-decoration:none;font-family:monospace;font-size:16px;margin:10px}</style></head><body><div id="status">🎬 Loading...</div><video id="v" controls autoplay playsinline style="display:none"></video><div id="controls"><a href="/channels">📺 Channels</a><a href="javascript:location.reload()" style="background:#333">🔄 Reload</a></div><script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script><script>const v=document.getElementById('v'),s=document.getElementById('status'),c=document.getElementById('controls'),u="${playUrl}";function fail(m){s.innerHTML='❌ '+m+'<br><br><small>Try VLC:<br>Media > Open Network Stream ><br>${playUrl}</small>';c.style.display='block'}if(Hls.isSupported()){const h=new Hls({debug:false,manifestLoadPolicy:{default:{maxTimeToFirstByteMs:30000,maxLoadTimeMs:60000}}});h.loadSource(u);h.attachMedia(v);h.on(Hls.Events.MANIFEST_PARSED,()=>{s.style.display='none';v.style.display='block';c.style.display='block';v.play().catch(()=>{})});h.on(Hls.Events.ERROR,(e,d)=>{console.error('HLS:',d);if(d.fatal)f('Stream error: '+d.details)})}else if(v.canPlayType('application/vnd.apple.mpegurl')){v.src=u;v.addEventListener('loadedmetadata',()=>{s.style.display='none';v.style.display='block';c.style.display='block'});v.addEventListener('error',()=>f('Video failed'))}else{f('Browser not supported. Use Chrome or VLC.')}</script></body></html>`;
  res.set("Content-Type", "text/html").send(html);
});

// ============================================
// 🔥 CONVERT ANYTHING TO MP4 — GET REQUEST
// ============================================
app.get("/convert", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing 'url' query parameter" });

    const id = uuidv4();
    const rawExt = path.extname(url).toLowerCase().split("?")[0];
    const ext = rawExt || ".unknown";
    const inputFile = path.join(TEMP_DIR, `${id}${ext}`);
    const outputFile = path.join(TEMP_DIR, `${id}.mp4`);

    console.log(`📥 Downloading: ${url}`);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = await response.buffer();
    fs.writeFileSync(inputFile, buffer);
    console.log(`📦 Downloaded: ${(buffer.length / 1024).toFixed(1)} KB`);

    // Detect if animated
    let isAnimated = false;
    try {
      const probe = execSync(`ffprobe -v quiet -print_format json -show_streams "${inputFile}"`, { timeout: 10000 }).toString();
      const streams = JSON.parse(probe).streams || [];
      isAnimated = streams.some(s => s.codec_type === "video" && (s.nb_frames > 1 || s.duration > 0.5));
      console.log(`🎬 Animated: ${isAnimated}`);
    } catch (e) { console.log("⚠️ Could not probe"); }

    console.log(`🔄 Converting to MP4...`);

    const isImage = [".webp", ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webm"].includes(ext);

    if (!isAnimated && isImage) {
      execSync(`ffmpeg -y -loop 1 -i "${inputFile}" -c:v libx264 -t 5 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -preset ultrafast -crf 23 -movflags +faststart "${outputFile}"`, { timeout: 30000, stdio: "pipe" });
    } else {
      try {
        execSync(`ffmpeg -y -i "${inputFile}" -vf "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -movflags +faststart -pix_fmt yuv420p "${outputFile}"`, { timeout: 60000, stdio: "pipe" });
      } catch (e) {
        execSync(`ffmpeg -y -i "${inputFile}" -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -movflags +faststart -an "${outputFile}"`, { timeout: 60000, stdio: "pipe" });
      }
    }

    if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size === 0) {
      throw new Error("Conversion produced empty file");
    }

    const stats = fs.statSync(outputFile);
    console.log(`✅ Done: ${(stats.size / 1024).toFixed(1)} KB`);

    res.set("Content-Type", "video/mp4");
    res.set("Content-Length", stats.size);
    res.set("X-Original-Format", ext);
    res.set("X-Animated", isAnimated);

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);

    stream.on("end", () => {
      try { fs.unlinkSync(inputFile); } catch (e) {}
      try { fs.unlinkSync(outputFile); } catch (e) {}
    });

  } catch (e) {
    console.error("❌ Convert error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// HOME
// ============================================
app.get("/", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    service: "Pluto TV US API v3.2 + Converter 🇺🇸",
    baseUrl,
    pluto: {
      health: `${baseUrl}/health`,
      channels: `${baseUrl}/channels`,
      channel: `${baseUrl}/channel?slug=cnn-headlines`,
      categories: `${baseUrl}/categories`,
      epg: `${baseUrl}/epg`,
      search: `${baseUrl}/search?q=cnn`,
      stream: `${baseUrl}/stream?id=ID`,
      play: `${baseUrl}/play?id=ID`,
      watch: `${baseUrl}/watch?slug=cnn-headlines`,
    },
    converter: {
      endpoint: `GET ${baseUrl}/convert?url=FILE_URL`,
      example: `${baseUrl}/convert?url=https://media.giphy.com/media/3o7TKz9b9oYPEQqCbK/giphy.gif`,
      formats: ["gif", "webp", "webm", "mov", "avi", "mkv", "flv", "wmv", "ogg", "png", "jpg"],
    },
  });
});

// ============================================
// KEEP ALIVE
// ============================================
setInterval(() => { fetch(`${API}/v2/channels?channelType=live&limit=1`, { headers: plutoHeaders() }).then(() => console.log("💓")).catch(() => {}); }, 10 * 60 * 1000);

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Pluto + Converter on port ${PORT}`));

// ============================================
// PLUTO TV US API + WEB PLAYER — RENDER
// Deploy on Render, Region: US (Oregon)
// ============================================

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());

const API = "https://api.pluto.tv";
const BOOT = "https://boot.pluto.tv";
const STITCHER = "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000;

function uid() { return uuidv4(); }

function plutoHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://pluto.tv",
    "Referer": "https://pluto.tv/",
  };
}

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

function buildStreamUrl(id) {
  const q = new URLSearchParams({
    advertisingId: "", appName: "web", appVersion: "9.21.0-bf9f5b4369933742859f3b2581c935110922f642",
    architecture: "", buildVersion: "", clientTime: new Date().toISOString(),
    deviceDNT: "false", deviceId: uid(), deviceLat: "34.0522", deviceLon: "-118.2437",
    deviceMake: "chrome", deviceModel: "web", deviceType: "web", deviceVersion: "148.0.7778",
    includeExtendedEvents: "false", marketingRegion: "US", serverSideAds: "false",
    sid: uid(), sessionID: uid(), userId: "",
  });
  return `${STITCHER}/stitch/hls/channel/${id}/master.m3u8?${q.toString()}`;
}

function rewritePlaylist(text, targetBase, baseUrl) {
  text = text.replace(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.m3u8[^\s"'<>]*/gim, m => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${m}`)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.ts[^\s"'<>]*/gim, m => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${m}`)}`);
  text = text.replace(/URI="(?!https?:\/\/)([^"]+)"/gi, (_, p) => `URI="${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${p}`)}"`);
  return text;
}

// ============================================
// API ENDPOINTS
// ============================================

// Health
app.get("/health", async (req, res) => {
  try {
    const r = await fetch(`${API}/v2/channels?channelType=live&limit=1`, { headers: plutoHeaders() });
    const d = await r.json();
    const ch = (Array.isArray(d) ? d : d.data || [])[0];
    res.json({ status: "ok", channel: ch?.name, slug: ch?.slug, isUS: ch?.slug ? !ch.slug.includes("-de") && !ch.slug.includes("-gb") && !ch.slug.includes("-fr") : false });
  } catch (e) {
    res.json({ status: "down", error: e.message });
  }
});

// Debug
app.get("/debug", async (req, res) => {
  try {
    const r = await fetch(`${BOOT}/v4/start?appName=web&appVersion=9.21.0&deviceVersion=148.0.7778&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${uid()}&clientModelNumber=1.0.0&serverSideAds=false&clientTime=${encodeURIComponent(new Date().toISOString())}`, { headers: plutoHeaders() });
    const d = await r.json();
    res.json({
      country: d.session?.countryCode,
      city: d.session?.city,
      ip: d.session?.clientIP,
      sampleChannel: (d.EPG || [])[0]?.name,
      sampleSlug: (d.EPG || [])[0]?.slug,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Channels
app.get("/channels", async (req, res) => {
  try {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL) {
      return res.json({ source: "cache", total: cache.length, usTotal: cache.filter(c => c.isUS).length, channels: cache });
    }

    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = (Array.isArray(d) ? d : d.data || []).map(ch => ({
      id: ch._id, name: ch.name, slug: ch.slug, number: ch.number,
      category: ch.category, description: ch.summary || "",
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
      logo: ch.logo?.path || "",
      isUS: !ch.slug?.includes("-de") && !ch.slug?.includes("-gb") && !ch.slug?.includes("-fr") && !ch.slug?.includes("-es") && !ch.slug?.includes("-it"),
      streamUrl: `/stream?id=${ch._id}`,
      playUrl: `/play?id=${ch._id}`,
      watchUrl: `/watch?slug=${ch.slug}`,
    }));

    cache = channels;
    cacheTime = now;
    res.json({ total: channels.length, usTotal: channels.filter(c => c.isUS).length, channels });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single Channel
app.get("/channel", async (req, res) => {
  try {
    const { slug, id } = req.query;
    if (!slug && !id) return res.status(400).json({ error: "Missing slug or id" });

    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const ch = channels.find(c => c.slug === slug || c._id === id);
    if (!ch) return res.status(404).json({ error: "Not found" });

    res.json({
      id: ch._id, name: ch.name, slug: ch.slug, number: ch.number,
      category: ch.category, description: ch.summary || "",
      thumbnail: ch.tile?.path || "", logo: ch.logo?.path || "",
      streamUrl: `/stream?id=${ch._id}`,
      playUrl: `/play?id=${ch._id}`,
      watchUrl: `/watch?slug=${ch.slug}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Categories
app.get("/categories", async (req, res) => {
  try {
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const cats = [...new Set(channels.map(c => c.category))].sort();
    res.json({ total: cats.length, categories: cats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// EPG
app.get("/epg", async (req, res) => {
  try {
    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    res.json({
      total: channels.length,
      programs: channels.map(ch => ({
        id: ch._id, name: ch.name, slug: ch.slug, number: ch.number,
        category: ch.category, streamUrl: `/stream?id=${ch._id}`,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const results = channels.filter(c => c.name?.toLowerCase().includes(q) || c.category?.toLowerCase().includes(q)).slice(0, 50).map(c => ({
      id: c._id, name: c.name, slug: c.slug, number: c.number,
      category: c.category, thumbnail: c.tile?.path || "",
      streamUrl: `/stream?id=${c._id}`,
      watchUrl: `/watch?slug=${c.slug}`,
    }));

    res.json({ query: q, total: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stream URL
app.get("/stream", async (req, res) => {
  try {
    const { id, slug } = req.query;
    if (!id && !slug) return res.status(400).json({ error: "Missing id or slug" });

    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const ch = channels.find(c => c._id === id || c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Not found" });

    res.json({ id: ch._id, name: ch.name, slug: ch.slug, streamUrl: buildStreamUrl(ch._id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// 🎬 PLAY — STREAM PROXY
// ============================================
app.get("/play", async (req, res) => {
  try {
    const { id, slug, url: directUrl } = req.query;
    const baseUrl = `https://${req.get("host")}`;

    if (directUrl) {
      const r = await fetch(directUrl, { headers: stitcherHeaders() });
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
      res.set("Cache-Control", "public, max-age=10");
      return res.send(body);
    }

    if (!id && !slug) return res.status(400).json({ error: "Missing id, slug, or url" });

    const r = await fetch(`${API}/v2/channels?channelType=live`, { headers: plutoHeaders() });
    const d = await r.json();
    const channels = Array.isArray(d) ? d : d.data || [];
    const ch = channels.find(c => c._id === id || c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Not found" });

    const masterUrl = buildStreamUrl(ch._id);
    const masterBase = masterUrl.replace(/\/master\.m3u8.*$/, "");
    const mr = await fetch(masterUrl, { headers: stitcherHeaders() });
    if (!mr.ok) return res.status(mr.status).send(`Stream error: ${mr.status}`);

    let text = await mr.text();
    text = rewritePlaylist(text, masterBase, baseUrl);

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-cache");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ============================================
// 🏠 HOME — CHANNEL BROWSER
// ============================================
app.get("/", (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pluto TV US 🇺🇸</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:Arial,sans-serif;padding:20px}
h1{text-align:center;color:#e50914;margin:20px 0}
.search{width:100%;padding:14px 20px;border-radius:12px;border:2px solid #333;background:#1a1a1a;color:#fff;font-size:16px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;max-width:1400px;margin:0 auto}
.card{background:#1a1a1a;border-radius:10px;padding:12px;display:flex;align-items:center;gap:10px;cursor:pointer;transition:0.2s;text-decoration:none;color:#fff}
.card:hover{background:#222;transform:scale(1.02)}
.card img{width:100px;height:56px;object-fit:cover;border-radius:6px;background:#333}
.card .info{flex:1;min-width:0}
.card .name{font-weight:bold;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .num{background:#e50914;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:6px}
.card .cat{font-size:11px;color:#aaa;margin-top:2px}
#loading{text-align:center;padding:40px;color:#aaa;font-size:18px}
.stats{text-align:center;color:#aaa;margin-bottom:15px;font-size:14px}
#player{display:none;margin-bottom:30px;background:#000;border-radius:16px;overflow:hidden}
#player .bar{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:#1a1a1a}
#player .bar .btn{background:#333;color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer}
#player video{width:100%;max-height:70vh;background:#000}
</style>
</head>
<body>
<h1>🇺🇸 Pluto TV</h1>
<div class="stats" id="stats"></div>
<input class="search" id="search" placeholder="🔍 Search channels..." oninput="filter()">
<div id="loading">📺 Loading channels...</div>
<div id="player">
  <div class="bar">
    <div><span id="chNum" style="background:#e50914;padding:2px 10px;border-radius:4px;margin-right:10px"></span><strong id="chName"></strong></div>
    <button class="btn" onclick="closePlayer()">✕ Close</button>
  </div>
  <video id="video" controls autoplay playsinline></video>
</div>
<div class="grid" id="grid"></div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<script>
let allChannels = [];
let hls = null;

async function load(){
  try{
    const r=await fetch('/channels');
    const d=await r.json();
    allChannels=d.channels;
    document.getElementById('loading').style.display='none';
    document.getElementById('stats').innerHTML='Channels: '+d.total+' | US: '+d.usTotal;
    render(d.channels);
  }catch(e){
    document.getElementById('loading').textContent='❌ '+

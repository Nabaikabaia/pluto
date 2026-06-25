// ============================================
// PLUTO TV PROXY RELAY v6 — FAST TOKEN
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

// ============================================
// CACHED US TOKEN — DIRECT CONNECTION (FAST)
// ============================================
let cachedToken = null;
let cachedTokenTime = 0;
const TOKEN_CACHE = 6 * 60 * 60 * 1000; // 6 hours

// ============================================
// PROXY POOL — ONLY FOR CHANNELS/STREAMS
// ============================================
let usProxies = [];
let lastProxyFetch = 0;
const PROXY_FETCH_INTERVAL = 10 * 60 * 1000;

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
    usProxies = (data.proxies || []).filter(p => p.countryCode === "US");
    lastProxyFetch = now;
    console.log(`✅ Fetched ${usProxies.length} US proxies`);
    return usProxies;
  } catch (e) {
    console.error("Proxy fetch failed:", e.message);
    return usProxies;
  }
}

// ============================================
// CREATE PROXY AGENT
// ============================================
function createAgent(proxy) {
  const type = proxy.type || "http";
  const url = `${type}://${proxy.query}:${proxy.port}`;
  try {
    if (type === "socks4" || type === "socks5") {
      return new SocksProxyAgent(url);
    }
    return new HttpsProxyAgent(url);
  } catch (e) {
    return null;
  }
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
    advertisingId: "", appName: "web", appVersion: "9.21.0-bf9f5b4369933742859f3b2581c935110922f642",
    architecture: "", buildVersion: "", clientTime: new Date().toISOString(),
    deviceDNT: "false", deviceId: uuidv4(), deviceLat: "34.0522", deviceLon: "-118.2437",
    deviceMake: "chrome", deviceModel: "web", deviceType: "web", deviceVersion: "148.0.7778",
    includeExtendedEvents: "false", marketingRegion: "US", serverSideAds: "false",
    sid: uuidv4(), sessionID: uuidv4(), userId: "",
  });
  return `${base}/stitch/hls/channel/${channel._id}/master.m3u8?${q.toString()}`;
}

// ============================================
// REWRITE PLAYLIST URLS
// ============================================
function rewritePlaylistUrls(text, targetBase, baseUrl) {
  text = text.replace(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.m3u8[^\s"'<>]*/gim, match => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${match}`)}`);
  text = text.replace(/^(?!#)(?!https?:\/\/)[^\s"'<>]+\.ts[^\s"'<>]*/gim, match => `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${match}`)}`);
  text = text.replace(/URI="(?!https?:\/\/)([^"]+)"/gi, (m, path) => `URI="${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${path}`)}"`);
  return text;
}

// ============================================
// 🚀 TOKEN — DIRECT CONNECTION (FAST)
// ============================================
app.get("/token", async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached token if fresh
    if (cachedToken && (now - cachedTokenTime) < TOKEN_CACHE) {
      return res.json({
        source: "cache",
        expiresIn: TOKEN_CACHE - (now - cachedTokenTime),
        ...cachedToken
      });
    }

    // Direct connection — Render's US IP
    const clientID = uuidv4();
    const timestamp = new Date().toISOString();
    const bootUrl = `https://boot.pluto.tv/v4/start?appName=web&appVersion=9.21.0-bf9f5b4369933742859f3b2581c935110922f642&deviceVersion=148.0.7778&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${clientID}&clientModelNumber=1.0.0&serverSideAds=false&clientTime=${encodeURIComponent(timestamp)}`;

    const response = await fetch(bootUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://pluto.tv",
        "Referer": "https://pluto.tv/",
      },
      timeout: 15000,
    });

    if (!response.ok) throw new Error(`Boot API: ${response.status}`);

    const data = await response.json();

    cachedToken = {
      sessionToken: data.sessionToken,
      stitcher: data.servers?.stitcher,
      stitcherParams: data.stitcherParams,
      session: data.session,
    };
    cachedTokenTime = now;

    console.log(`🇺🇸 Token: ${data.session?.country} - ${data.session?.city}`);

    res.json({
      source: "fresh",
      expiresIn: TOKEN_CACHE,
      ...cachedToken
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// HEALTH
// ============================================
app.get("/health", async (req, res) => {
  try {
    const response = await fetch("https://api.pluto.tv/v2/channels?channelType=live&limit=1", {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      timeout: 10000,
    });
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    res.json({
      status: "ok",
      channel: channels[0]?.name,
      slug: channels[0]?.slug,
      tokenCached: !!cachedToken,
      uptime: process.uptime(),
    });
  } catch (e) {
    res.json({ status: "degraded", error: e.message });
  }
});

// ============================================
// KEEP ALIVE
// ============================================
setInterval(() => {
  fetch("https://boot.pluto.tv/v4/start?appName=web&appVersion=9.21.0&deviceVersion=148.0.7778&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=" + uuidv4() + "&clientModelNumber=1.0.0&serverSideAds=false&clientTime=" + encodeURIComponent(new Date().toISOString()), {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    timeout: 10000,
  }).then(() => console.log("💓 Keep-alive")).catch(() => {});
}, 10 * 60 * 1000);

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Pluto Token Server on port ${PORT}`);
});

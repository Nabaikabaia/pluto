// ============================================
// PLUTO TV PROXY RELAY — DEPLOY ON RENDER
// Region: US (Oregon or Ohio)
// ============================================

const express = require("express");
const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());

// Cache
let usProxies = [];
let currentProxy = null;
let lastProxyFetch = 0;
let lastProxyRotate = 0;
const PROXY_FETCH_INTERVAL = 15 * 60 * 1000;
const PROXY_ROTATE_INTERVAL = 5 * 60 * 1000;

// ============================================
// FETCH FRESH US PROXIES
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
    console.error("Failed to fetch proxies:", e.message);
    return usProxies;
  }
}

// ============================================
// GET A WORKING US PROXY
// ============================================
async function getWorkingProxy() {
  const now = Date.now();

  if (currentProxy && (now - lastProxyRotate) < PROXY_ROTATE_INTERVAL) {
    return currentProxy;
  }

  const proxies = await fetchUSProxies();
  const shuffled = proxies.sort(() => Math.random() - 0.5);

  for (const proxy of shuffled) {
    try {
      const agent = createAgent(proxy);

      const testRes = await fetch("https://api.pluto.tv/v2/channels?channelType=live&limit=1", {
        agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Origin": "https://pluto.tv",
          "Referer": "https://pluto.tv/",
        },
        timeout: 10000,
      });

      if (testRes.ok) {
        const data = await testRes.json();
        const channels = Array.isArray(data) ? data : data.data || [];
        const ch = channels[0];

        if (ch && ch.slug && !ch.slug.includes("-gb")) {
          currentProxy = proxy;
          lastProxyRotate = now;
          console.log(`✅ Working US proxy: ${proxy.query}:${proxy.port} (${proxy.city}, ${proxy.regionName})`);
          return proxy;
        }
      }
    } catch (e) {
      // Try next
    }
  }

  console.log("⚠️ No working US proxy found, using direct connection");
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
// SMART FETCH THROUGH PROXY
// ============================================
async function proxyFetch(url, options = {}) {
  const proxy = await getWorkingProxy();

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

  if (proxy) {
    fetchOptions.agent = createAgent(proxy);
  }

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
function buildStreamUrl(channel, stitcher) {
  const base = stitcher || "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
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
// HEALTH CHECK
// ============================================
app.get("/health", async (req, res) => {
  const proxy = await getWorkingProxy();
  const proxies = await fetchUSProxies();

  res.json({
    status: "ok",
    proxy: proxy ? `${proxy.query}:${proxy.port}` : "none (direct)",
    proxyCity: proxy?.city || "unknown",
    proxyRegion: proxy?.regionName || "unknown",
    totalProxies: proxies.length,
    uptime: process.uptime(),
  });
});

// ============================================
// GET CHANNELS
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
      isUS: !ch.slug?.includes("-gb") && !ch.slug?.includes("-uk"),
    }));

    const usChannels = channels.filter(c => c.isUS);
    res.json({
      total: channels.length,
      usChannels: usChannels.length,
      channels,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// GET STREAM URL
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

    const streamUrl = buildStreamUrl(ch);

    res.json({
      channel: ch.name,
      slug: ch.slug,
      number: ch.number,
      streamUrl,
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
      logo: ch.logo?.path || "",
      isUS: !ch.slug?.includes("-gb"),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// 🎬 STREAM PROXY — PLAYS THE VIDEO
// ============================================
app.get("/play", async (req, res) => {
  const slug = req.query.slug;
  const directUrl = req.query.url;
  const host = req.get("host");
  const protocol = req.protocol;
  const baseUrl = `${protocol}://${host}`;

  try {
    // If a direct URL is given, proxy it
    if (directUrl) {
      const response = await proxyFetch(directUrl, {
        headers: stitcherHeaders(),
      });

      if (!response.ok) return res.status(response.status).send(`Error: ${response.status}`);

      const contentType = response.headers.get("content-type") || "";
      const body = await response.buffer();

      // If it's an m3u8 playlist, rewrite URLs
      if (directUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
        let text = body.toString();
        const targetBase = directUrl.replace(/\/[^\/]+\.m3u8.*$/, "");

        // Rewrite absolute URLs
        text = text.replace(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
        text = text.replace(/(https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
        text = text.replace(/(https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);

        // Rewrite relative paths
        text = text.replace(/^((?!https?:\/\/)(?!\#)[^\s"'<>]+\.m3u8[^\s"'<>]*)/gim, match => {
          return `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${match}`)}`;
        });
        text = text.replace(/^((?!https?:\/\/)(?!\#)[^\s"'<>]+\.ts[^\s"'<>]*)/gim, match => {
          return `${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${match}`)}`;
        });
        text = text.replace(/URI="((?!https?:\/\/)[^"]+)"/gi, (match, path) => {
          return `URI="${baseUrl}/play?url=${encodeURIComponent(`${targetBase}/${path}`)}"`;
        });

        res.set("Content-Type", "application/vnd.apple.mpegurl");
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Cache-Control", "no-cache");
        return res.send(text);
      }

      // Binary files (.ts, .key)
      res.set("Content-Type", contentType || "application/octet-stream");
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Cache-Control", "public, max-age=10");
      return res.send(body);
    }

    // Get channel stream
    if (!slug) return res.status(400).json({ error: "Missing ?slug= or ?url=" });

    const response = await proxyFetch("https://api.pluto.tv/v2/channels?channelType=live");
    const data = await response.json();
    const channels = Array.isArray(data) ? data : data.data || [];
    const ch = channels.find(c => c.slug === slug);
    if (!ch) return res.status(404).json({ error: "Channel not found" });

    const masterUrl = buildStreamUrl(ch);
    const masterBase = masterUrl.replace(/\/master\.m3u8.*$/, "");

    const masterRes = await proxyFetch(masterUrl, {
      headers: stitcherHeaders(),
    });

    if (!masterRes.ok) return res.status(masterRes.status).send(`Stream error: ${masterRes.status}`);

    let text = await masterRes.text();

    // Rewrite all URLs
    text = text.replace(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
    text = text.replace(/(https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);
    text = text.replace(/(https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*)/gi, m => `${baseUrl}/play?url=${encodeURIComponent(m)}`);

    text = text.replace(/^((?!https?:\/\/)(?!\#)[^\s"'<>]+\.m3u8[^\s"'<>]*)/gim, match => {
      return `${baseUrl}/play?url=${encodeURIComponent(`${masterBase}/${match}`)}`;
    });

    text = text.replace(/URI="((?!https?:\/\/)[^"]+)"/gi, (match, path) => {
      return `URI="${baseUrl}/play?url=${encodeURIComponent(`${masterBase}/${path}`)}"`;
    });

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "no-cache");
    res.send(text);

  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Pluto Proxy Relay running on port ${PORT}`);
  fetchUSProxies();
});

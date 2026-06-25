// ============================================
// PLUTO TV PROXY RELAY — DEPLOY ON RENDER
// Region: US (Oregon or Ohio)
// ============================================

const express = require("express");
const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const cors = require("cors");

const app = express();
app.use(cors());

// Cache
let usProxies = [];
let currentProxy = null;
let lastProxyFetch = 0;
const PROXY_FETCH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const PROXY_ROTATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
let lastProxyRotate = 0;

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
    return usProxies; // Return stale cache
  }
}

// ============================================
// GET A WORKING US PROXY
// ============================================
async function getWorkingProxy() {
  const now = Date.now();
  
  // Return cached proxy if still fresh
  if (currentProxy && (now - lastProxyRotate) < PROXY_ROTATE_INTERVAL) {
    return currentProxy;
  }

  const proxies = await fetchUSProxies();
  const shuffled = proxies.sort(() => Math.random() - 0.5);

  for (const proxy of shuffled) {
    try {
      const agent = createAgent(proxy);
      
      // Test if this proxy works with Pluto
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

        // Verify it's US (no "-gb" suffix)
        if (ch && ch.slug && !ch.slug.includes("-gb")) {
          currentProxy = proxy;
          lastProxyRotate = now;
          console.log(`✅ Working US proxy: ${proxy.query}:${proxy.port} (${proxy.city}, ${proxy.regionName})`);
          return proxy;
        }
      }
    } catch (e) {
      // This proxy failed, try next
    }
  }

  // No working proxy found
  console.log("⚠️ No working US proxy found");
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

  // Use proxy if available
  if (proxy) {
    fetchOptions.agent = createAgent(proxy);
  }

  return fetch(url, fetchOptions);
}

// ============================================
// HEALTH CHECK
// ============================================
app.get("/health", async (req, res) => {
  const proxy = await getWorkingProxy();
  const proxies = await fetchUSProxies();
  
  res.json({
    status: "ok",
    proxy: proxy ? `${proxy.query}:${proxy.port}` : "none",
    proxyCity: proxy?.city || "unknown",
    proxyRegion: proxy?.regionName || "unknown",
    totalProxies: proxies.length,
    uptime: process.uptime(),
  });
});

// ============================================
// PROXY ANY PLUTO URL
// ============================================
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Missing ?url=" });

  try {
    const response = await proxyFetch(targetUrl, {
      headers: {
        "Accept": "*/*",
        "plutotv-device-dnt": "false",
        "plutotv-device-model": "web",
        "plutotv-device-make": "chrome",
        "plutotv-device-type": "web",
        "plutotv-device-version": "148.0.7778",
        "plutotv-app-name": "web",
        "plutotv-app-version": "9.21.0",
      }
    });

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const body = await response.buffer();

    res.set("Content-Type", contentType);
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=10");
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
      logo: ch.logo?.path || "",
      isUS: !ch.slug?.includes("-gb"),
    }));

    res.json({ total: channels.length, channels });
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

    const stitcher = "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
    const { v4: uuidv4 } = require("uuid");
    
    const q = new URLSearchParams({
      advertisingId: "", appName: "web", appVersion: "9.21.0-bf9f5b4369933742859f3b2581c935110922f642",
      architecture: "", buildVersion: "", clientTime: new Date().toISOString(),
      deviceDNT: "false", deviceId: uuidv4(), deviceLat: "34.0522", deviceLon: "-118.2437",
      deviceMake: "chrome", deviceModel: "web", deviceType: "web", deviceVersion: "148.0.7778",
      includeExtendedEvents: "false", marketingRegion: "US", serverSideAds: "false",
      sid: uuidv4(), sessionID: uuidv4(), userId: "",
    });

    const streamUrl = `${stitcher}/stitch/hls/channel/${ch._id}/master.m3u8?${q.toString()}`;

    res.json({
      channel: ch.name,
      slug: ch.slug,
      streamUrl,
      isUS: !ch.slug?.includes("-gb"),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Pluto Proxy Relay running on port ${PORT}`);
  fetchUSProxies(); // Pre-fetch proxies on startup
});

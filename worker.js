// ============================================
// 🇺🇸 PLUTO TV API v3.5 — WITH STREAM PROXY
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
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

// ============================================
// GET BOOT DATA
// ============================================
async function getBootData() {
  const now = Date.now();
  
  if (cachedBoot && (now - cachedBootTime) < CACHE_DURATION) {
    return jsonResponse({ source: "cache", expiresIn: CACHE_DURATION - (now - cachedBootTime), ...cachedBoot });
  }

  const clientID = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const bootUrl = `https://boot.pluto.tv/v4/start?appName=web&appVersion=9.21.0-bf9f5b4369933742859f3b2581c935110922f642&deviceVersion=148.0.7778&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${clientID}&clientModelNumber=1.0.0&serverSideAds=false&clientTime=${encodeURIComponent(timestamp)}`;

  const response = await fetch(bootUrl, {
    cf: { colo: "LAX" },
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Origin": "https://pluto.tv",
      "Referer": "https://pluto.tv/",
    }
  });

  if (!response.ok) throw new Error(`Boot API returned ${response.status}`);

  const data = await response.json();

  cachedBoot = {
    sessionToken: data.sessionToken,
    stitcher: data.servers?.stitcher,
    stitcherParams: data.stitcherParams,
    session: data.session,
    epg: data.EPG,
    refreshInSec: data.refreshInSec,
    serverTime: data.serverTime,
  };
  cachedBootTime = now;

  return jsonResponse({ source: "fresh", expiresIn: CACHE_DURATION, ...cachedBoot });
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
    description: ch.summary || "",
    thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
    logo: ch.logo?.path || ch.colorLogoPNG?.path || "",
    isStitched: ch.isStitched || false,
    streamUrl: `/stream?slug=${ch.slug}`,
    playUrl: `/play?slug=${ch.slug}`,
    nowPlaying: ch.currentBroadcast?.title || ch.currentProgram?.title || null,
  }));

  return jsonResponse({ total: channels.length, channels }, 200, 300);
}

// ============================================
// GET TOKEN
// ============================================
async function getToken() {
  const boot = await getBootDataFromCache();
  if (!boot.sessionToken) return jsonResponse({ error: "No token available" }, 500);
  return jsonResponse({
    sessionToken: boot.sessionToken,
    expiresIn: boot.refreshInSec,
    country: boot.session?.country || "unknown",
  });
}

// ============================================
// GET STREAM URL
// ============================================
async function getStreamUrl(params) {
  const slug = params.get("slug");
  if (!slug) return jsonResponse({ error: "Missing ?slug= parameter" }, 400);

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const channel = channels.find(ch => ch.slug === slug);
  if (!channel) return jsonResponse({ error: "Channel not found" }, 404);

  const streamUrl = buildStreamUrl(channel);

  return jsonResponse({
    channel: channel.name,
    slug: channel.slug,
    number: channel.number,
    streamUrl: streamUrl,
    playUrl: `/play?slug=${channel.slug}`,
    thumbnail: channel.tile?.path || channel.thumbnail?.path || "",
    logo: channel.logo?.path || "",
    nowPlaying: channel.currentBroadcast?.title || channel.currentProgram?.title || null,
    note: "Use /play?slug=CHANNEL to proxy the stream through the Worker"
  });
}

// ============================================
// 🎬 STREAM PROXY — THE MAGIC
// ============================================
async function proxyStream(url, request) {
  const slug = url.searchParams.get("slug");
  const directUrl = url.searchParams.get("url");

  // If proxying a specific .ts or .m3u8 file
  if (directUrl) {
    return proxyMediaFile(directUrl, request);
  }

  if (!slug) {
    return jsonResponse({ error: "Missing ?slug=channel or ?url=direct-url" }, 400);
  }

  // Get channel and build master playlist URL
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const channel = channels.find(ch => ch.slug === slug);
  if (!channel) return jsonResponse({ error: "Channel not found" }, 404);

  const masterUrl = buildStreamUrl(channel);
  const baseUrl = new URL(request.url).origin;

  // Fetch master playlist from Worker (bypasses geolock)
  const response = await fetch(masterUrl, {
    cf: { colo: "LAX" },
    headers: getStitcherHeaders(),
  });

  if (!response.ok) {
    return new Response(`Failed to fetch stream: ${response.status}`, { status: response.status });
  }

  let playlist = await response.text();

  // Rewrite ALL URLs to go through our proxy
  playlist = playlist.replace(
    /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi,
    (match) => `${baseUrl}/play?url=${encodeURIComponent(match)}`
  );
  playlist = playlist.replace(
    /(https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*)/gi,
    (match) => `${baseUrl}/play?url=${encodeURIComponent(match)}`
  );
  playlist = playlist.replace(
    /(https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*)/gi,
    (match) => `${baseUrl}/play?url=${encodeURIComponent(match)}`
  );

  return new Response(playlist, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    }
  });
}

// ============================================
// PROXY INDIVIDUAL MEDIA FILES
// ============================================
async function proxyMediaFile(targetUrl, request) {
  const response = await fetch(targetUrl, {
    cf: { colo: "LAX" },
    headers: getStitcherHeaders(),
  });

  if (!response.ok) {
    return new Response(`Proxy error: ${response.status}`, { status: response.status });
  }

  const body = await response.arrayBuffer();
  let contentType = response.headers.get("content-type") || "";

  if (!contentType) {
    if (targetUrl.includes(".m3u8")) contentType = "application/vnd.apple.mpegurl";
    else if (targetUrl.includes(".ts")) contentType = "video/mp2t";
    else if (targetUrl.includes(".key")) contentType = "application/octet-stream";
    else contentType = "application/octet-stream";
  }

  // If it's a sub-playlist, rewrite URLs inside it too
  if (targetUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
    const decoder = new TextDecoder();
    let text = decoder.decode(body);
    const baseUrl = new URL(request.url).origin;

    text = text.replace(
      /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi,
      (match) => `${baseUrl}/play?url=${encodeURIComponent(match)}`
    );
    text = text.replace(
      /(https?:\/\/[^\s"'<>]+\.ts[^\s"'<>]*)/gi,
      (match) => `${baseUrl}/play?url=${encodeURIComponent(match)}`
    );
    text = text.replace(
      /(https?:\/\/[^\s"'<>]+\.key[^\s"'<>]*)/gi,
      (match) => `${baseUrl}/play?url=${encodeURIComponent(match)}`
    );

    const encoder = new TextEncoder();
    const rewritten = encoder.encode(text);
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Content-Length": rewritten.byteLength,
      }
    });
  }

  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=10",
      "Content-Length": body.byteLength,
    }
  });
}

// ============================================
// GET SINGLE CHANNEL
// ============================================
async function getChannel(params) {
  const slug = params.get("slug");
  if (!slug) return jsonResponse({ error: "Missing ?slug= parameter" }, 400);

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const ch = channels.find(c => c.slug === slug);
  if (!ch) return jsonResponse({ error: "Channel not found" }, 404);

  return jsonResponse({
    channel: {
      id: ch._id,
      name: ch.name,
      slug: ch.slug,
      number: ch.number,
      category: ch.category,
      description: ch.summary || "",
      thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
      logo: ch.logo?.path || ch.colorLogoPNG?.path || "",
      isStitched: ch.isStitched || false,
    },
    streamUrl: `/stream?slug=${ch.slug}`,
    playUrl: `/play?slug=${ch.slug}`,
    nowPlaying: ch.currentBroadcast?.title || ch.currentProgram?.title || null,
  }, 200, 60);
}

// ============================================
// GET CATEGORIES
// ============================================
async function getCategories() {
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const categories = [...new Set(channels.map(ch => ch.category))].sort();
  return jsonResponse({ total: categories.length, categories }, 200, 600);
}

// ============================================
// GET EPG
// ============================================
async function getEPG() {
  const boot = await getBootDataFromCache();
  
  if (boot.epg && boot.epg.length > 0) {
    const programs = boot.epg.flatMap(ch => 
      (ch.timelines || []).map(t => ({
        channelName: ch.name,
        channelSlug: ch.slug,
        channelNumber: ch.number,
        title: t.title,
        startTime: t.start,
        endTime: t.stop,
        genre: t.episode?.genre,
        rating: t.episode?.rating,
        description: t.episode?.description,
      }))
    );
    return jsonResponse({ total: programs.length, programs }, 200, 120);
  }

  return jsonResponse({ error: "No EPG data" }, 404);
}

// ============================================
// SEARCH
// ============================================
async function searchChannels(query) {
  if (!query) return jsonResponse({ error: "Missing ?q= parameter" }, 400);

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const q = query.toLowerCase();

  const results = channels.filter(ch =>
    ch.name?.toLowerCase().includes(q) ||
    ch.category?.toLowerCase().includes(q) ||
    ch.summary?.toLowerCase().includes(q)
  ).slice(0, 30).map(ch => ({
    id: ch._id,
    name: ch.name,
    slug: ch.slug,
    number: ch.number,
    category: ch.category,
    thumbnail: ch.tile?.path || ch.thumbnail?.path || "",
    logo: ch.logo?.path || "",
    streamUrl: `/stream?slug=${ch.slug}`,
    playUrl: `/play?slug=${ch.slug}`,
  }));

  return jsonResponse({ query, total: results.length, results }, 200, 120);
}

// ============================================
// INTERNAL HELPERS
// ============================================
function buildStreamUrl(channel) {
  const stitcher = cachedBoot?.stitcher || "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
  const deviceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const clientTime = new Date().toISOString();

  const queryParams = new URLSearchParams({
    advertisingId: "",
    appName: "web",
    appVersion: "9.21.0-bf9f5b4369933742859f3b2581c935110922f642",
    architecture: "",
    buildVersion: "",
    clientTime: clientTime,
    deviceDNT: "false",
    deviceId: deviceId,
    deviceLat: "34.0522",
    deviceLon: "-118.2437",
    deviceMake: "chrome",
    deviceModel: "web",
    deviceType: "web",
    deviceVersion: "148.0.7778",
    includeExtendedEvents: "false",
    marketingRegion: "US",
    serverSideAds: "false",
    sid: sessionId,
    sessionID: sessionId,
    userId: "",
  });

  return `${stitcher}/stitch/hls/channel/${channel._id}/master.m3u8?${queryParams.toString()}`;
}

function getStitcherHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
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

async function getBootDataFromCache() {
  const now = Date.now();
  
  if (cachedBoot && (now - cachedBootTime) < CACHE_DURATION) {
    return cachedBoot;
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

  const data = await response.json();

  cachedBoot = {
    sessionToken: data.sessionToken,
    stitcher: data.servers?.stitcher,
    stitcherParams: data.stitcherParams,
    session: data.session,
    epg: data.EPG,
    refreshInSec: data.refreshInSec,
    serverTime: data.serverTime,
  };
  cachedBootTime = now;

  return cachedBoot;
}

async function plutoFetch(endpoint) {
  const response = await fetch(`https://api.pluto.tv${endpoint}`, {
    cf: { colo: "LAX" },
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "application/json",
      "Origin": "https://pluto.tv",
      "Referer": "https://pluto.tv/",
    }
  });
  return response.json();
}

function apiDocs() {
  return jsonResponse({
    service: "Pluto TV API v3.5 — WITH STREAM PROXY 🎬",
    endpoints: {
      "/boot": "Boot data — cached 7hrs",
      "/token": "JWT session token",
      "/channels": "All live channels",
      "/channel?slug=cnn": "Channel details",
      "/categories": "All categories",
      "/epg": "Program guide",
      "/search?q=comedy": "Search",
      "/stream?slug=cnn": "Get stream URL",
      "/play?slug=cnn": "🎬 PROXY STREAM — Open in VLC!",
    },
    usage: {
      vlc: "Media > Open Network Stream > https://YOUR_WORKER.workers.dev/play?slug=pluto-tv-movies-gb-1",
      browser: "Use with hls.js player pointing to /play?slug=CHANNEL",
    }
  });
}

function jsonResponse(data, status = 200, maxAge = 60) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${maxAge}`,
    }
  });
}

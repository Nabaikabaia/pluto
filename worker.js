// ============================================
// 🇺🇸 PLUTO TV API v3.0 — BOOT API POWERED
// Cloudflare Worker
// ============================================

let cachedBoot = null;
let cachedBootTime = 0;
const CACHE_DURATION = 7 * 60 * 60 * 1000; // 7 hours

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
// GET BOOT DATA (CACHED)
// ============================================
async function getBootData() {
  const now = Date.now();
  
  if (cachedBoot && (now - cachedBootTime) < CACHE_DURATION) {
    return jsonResponse({
      source: "cache",
      expiresIn: CACHE_DURATION - (now - cachedBootTime),
      ...cachedBoot
    });
  }

  const clientID = crypto.randomUUID();
  const sessionID = crypto.randomUUID();
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

  if (!response.ok) {
    throw new Error(`Boot API returned ${response.status}`);
  }

  const data = await response.json();

  // Cache it
  cachedBoot = {
    sessionToken: data.sessionToken,
    stitcher: data.servers?.stitcher,
    stitcherDash: data.servers?.stitcherDash,
    stitcherParams: data.stitcherParams,
    session: data.session,
    epg: data.EPG,
    refreshInSec: data.refreshInSec,
    serverTime: data.serverTime,
  };
  cachedBootTime = now;

  return jsonResponse({
    source: "fresh",
    expiresIn: CACHE_DURATION,
    ...cachedBoot
  });
}

// ============================================
// GET JWT TOKEN ONLY
// ============================================
async function getToken() {
  const boot = await getBootDataFromCache();
  
  if (!boot.sessionToken) {
    return jsonResponse({ error: "No token available" }, 500);
  }

  return jsonResponse({
    sessionToken: boot.sessionToken,
    expiresIn: boot.refreshInSec,
    stitcher: boot.stitcher,
    note: "Use this token in Authorization: Bearer header for stream requests"
  });
}

// ============================================
// GET STREAM URL WITH VALID TOKEN
// ============================================
async function getStreamUrl(params) {
  const slug = params.get("slug");
  if (!slug) return jsonResponse({ error: "Missing ?slug= parameter" }, 400);

  // Get boot data (with token and EPG)
  const boot = await getBootDataFromCache();
  
  if (!boot.sessionToken) {
    return jsonResponse({ error: "No session token. Hit /boot first." }, 500);
  }

  // Find channel in EPG
  const channel = boot.epg?.find(ch => ch.slug === slug);
  
  if (!channel) {
    // Fallback: search API
    const data = await plutoFetch("/v2/channels?channelType=live");
    const channels = Array.isArray(data) ? data : data.data || [];
    const found = channels.find(ch => ch.slug === slug);
    
    if (!found) return jsonResponse({ error: "Channel not found" }, 404);

    // Build stream URL using boot data
    const stitcher = boot.stitcher || "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
    const streamUrl = `${stitcher}${found.stitched?.path || `/stitch/hls/channel/${found._id}/master.m3u8`}?${boot.stitcherParams || ''}`;

    return jsonResponse({
      channel: found.name,
      slug: found.slug,
      streamUrl: streamUrl,
      token: boot.sessionToken,
      stitcher: stitcher,
      note: "Use VPN + this URL in VLC. Token valid for 8 hours."
    });
  }

  // Use EPG data
  const stitcher = boot.stitcher || "https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv";
  const streamUrl = `${stitcher}${channel.stitched.path}?${boot.stitcherParams || ''}`;

  return jsonResponse({
    channel: channel.name,
    slug: channel.slug,
    streamUrl: streamUrl,
    token: boot.sessionToken,
    stitcher: stitcher,
    timeline: channel.timelines,
    note: "Use VPN + this URL in VLC. Token embedded in URL params."
  });
}

// ============================================
// GET BOOT FROM CACHE (INTERNAL)
// ============================================
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
    stitcherDash: data.servers?.stitcherDash,
    stitcherParams: data.stitcherParams,
    session: data.session,
    epg: data.EPG,
    refreshInSec: data.refreshInSec,
    serverTime: data.serverTime,
  };
  cachedBootTime = now;

  return cachedBoot;
}

// ============================================
// GET ALL CHANNELS (FROM EPG)
// ============================================
async function getChannels() {
  const boot = await getBootDataFromCache();
  
  if (boot.epg) {
    const channels = boot.epg.map(ch => ({
      id: ch.id,
      name: ch.name,
      slug: ch.slug,
      number: ch.number,
      isStitched: ch.isStitched,
      thumbnail: ch.images?.find(i => i.type === "tileColor")?.url || "",
      logo: ch.images?.find(i => i.type === "colorLogoPNG")?.url || "",
      streamUrl: `/stream?slug=${ch.slug}`,
      nowPlaying: ch.timelines?.[0]?.title || "Unknown",
    }));
    return jsonResponse({ total: channels.length, source: "boot-epg", channels }, 200, 300);
  }

  // Fallback to API
  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = (Array.isArray(data) ? data : data.data || []).map(ch => ({
    id: ch._id,
    name: ch.name,
    slug: ch.slug,
    number: ch.number,
    category: ch.category,
    isStitched: ch.isStitched || false,
    streamUrl: `/stream?slug=${ch.slug}`,
  }));

  return jsonResponse({ total: channels.length, source: "api", channels }, 200, 300);
}

// ============================================
// GET SINGLE CHANNEL
// ============================================
async function getChannel(params) {
  const slug = params.get("slug");
  if (!slug) return jsonResponse({ error: "Missing ?slug= parameter" }, 400);

  const boot = await getBootDataFromCache();
  
  if (boot.epg) {
    const ch = boot.epg.find(c => c.slug === slug);
    if (ch) {
      return jsonResponse({
        channel: {
          id: ch.id,
          name: ch.name,
          slug: ch.slug,
          number: ch.number,
          isStitched: ch.isStitched,
          thumbnail: ch.images?.find(i => i.type === "tileColor")?.url || "",
          logo: ch.images?.find(i => i.type === "colorLogoPNG")?.url || "",
        },
        streamUrl: `/stream?slug=${ch.slug}`,
        timeline: ch.timelines,
      }, 200, 60);
    }
  }

  return jsonResponse({ error: "Channel not found" }, 404);
}

// ============================================
// GET CATEGORIES
// ============================================
async function getCategories() {
  const boot = await getBootDataFromCache();
  
  if (boot.epg) {
    const categoryIDs = boot.epg.flatMap(ch => ch.categoryIDs || []);
    const unique = [...new Set(categoryIDs)].sort();
    return jsonResponse({ total: unique.length, categories: unique, source: "boot-epg" }, 200, 600);
  }

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const categories = [...new Set(channels.map(ch => ch.category))].sort();
  return jsonResponse({ total: categories.length, categories, source: "api" }, 200, 600);
}

// ============================================
// GET EPG
// ============================================
async function getEPG() {
  const boot = await getBootDataFromCache();
  
  if (boot.epg) {
    const programs = boot.epg.flatMap(ch => 
      (ch.timelines || []).map(t => ({
        channelName: ch.name,
        channelSlug: ch.slug,
        channelNumber: ch.number,
        title: t.title,
        startTime: t.start,
        endTime: t.stop,
        episodeId: t.episode?._id,
        genre: t.episode?.genre,
        rating: t.episode?.rating,
        description: t.episode?.description,
      }))
    );
    return jsonResponse({ total: programs.length, programs, source: "boot-epg" }, 200, 120);
  }

  return jsonResponse({ error: "No EPG data" }, 404);
}

// ============================================
// SEARCH
// ============================================
async function searchChannels(query) {
  if (!query) return jsonResponse({ error: "Missing ?q= parameter" }, 400);

  const boot = await getBootDataFromCache();
  const q = query.toLowerCase();

  if (boot.epg) {
    const results = boot.epg.filter(ch =>
      ch.name?.toLowerCase().includes(q) ||
      ch.timelines?.some(t => t.title?.toLowerCase().includes(q))
    ).slice(0, 30).map(ch => ({
      id: ch.id,
      name: ch.name,
      slug: ch.slug,
      number: ch.number,
      thumbnail: ch.images?.find(i => i.type === "tileColor")?.url || "",
      nowPlaying: ch.timelines?.[0]?.title || "Unknown",
      streamUrl: `/stream?slug=${ch.slug}`,
    }));

    return jsonResponse({ query, total: results.length, results, source: "boot-epg" }, 200, 120);
  }

  const data = await plutoFetch("/v2/channels?channelType=live");
  const channels = Array.isArray(data) ? data : data.data || [];
  const results = channels.filter(ch =>
    ch.name?.toLowerCase().includes(q) || ch.category?.toLowerCase().includes(q)
  ).slice(0, 30).map(ch => ({
    id: ch._id,
    name: ch.name,
    slug: ch.slug,
    number: ch.number,
    streamUrl: `/stream?slug=${ch.slug}`,
  }));

  return jsonResponse({ query, total: results.length, results, source: "api" }, 200, 120);
}

// ============================================
// SHARED FETCH
// ============================================
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

// ============================================
// API DOCS
// ============================================
function apiDocs() {
  return jsonResponse({
    service: "Pluto TV API v3.0 — Boot API Powered 🇺🇸",
    endpoints: {
      "/boot": "Get boot data (token, stitcher, EPG) — cached 7 hours",
      "/token": "Get valid JWT session token",
      "/channels": "All channels from EPG",
      "/channel?slug=pluto-tv-spotlight": "Channel details + timeline",
      "/categories": "All category IDs",
      "/epg": "Full program guide",
      "/search?q=comedy": "Search channels",
      "/stream?slug=pluto-tv-spotlight": "Get stream URL with valid token",
    },
    usage: {
      step1: "GET /token → get sessionToken",
      step2: "GET /stream?slug=channel → get stream URL",
      step3: "Open stream URL in VLC with US VPN",
      note: "Token valid for 8 hours from boot"
    }
  });
}

// ============================================
// HELPERS
// ============================================
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

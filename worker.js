// ============================================
// PLUTO TV DEBUG PROBE
// Cloudflare Worker
// ============================================

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/debug") {
      // Probe the channels API structure
      const response = await fetch("https://api.pluto.tv/v2/channels?channelType=live", {
        cf: { colo: "LAX" },
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Origin": "https://pluto.tv",
          "Referer": "https://pluto.tv/",
        }
      });

      const data = await response.json();
      const channels = Array.isArray(data) ? data : data.data || [];
      const first = channels[0] || {};
      const second = channels[1] || {};
      const third = channels[2] || {};

      return new Response(JSON.stringify({
        totalChannels: channels.length,
        firstChannel: {
          keys: Object.keys(first),
          all: first,
        },
        secondChannel: {
          keys: Object.keys(second),
          all: second,
        },
        thirdChannel: {
          keys: Object.keys(third),
          all: third,
        },
        checkFields: {
          hasCurrentBroadcast: !!first.currentBroadcast,
          hasCurrentProgram: !!first.currentProgram,
          hasTimelines: !!first.timelines,
          hasEPG: !!first.epg,
          hasNowPlaying: !!first.nowPlaying,
          hasOnNow: !!first.onNow,
          hasProgram: !!first.program,
        }
      }, null, 2), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Also probe a single channel with its full details
    if (path === "/debug-channel") {
      const slug = url.searchParams.get("slug") || "pluto-tv-movies-gb-1";
      const response = await fetch(`https://api.pluto.tv/v2/channels?channelType=live`, {
        cf: { colo: "LAX" },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Origin": "https://pluto.tv",
          "Referer": "https://pluto.tv/",
        }
      });

      const data = await response.json();
      const channels = Array.isArray(data) ? data : data.data || [];
      const channel = channels.find(c => c.slug === slug) || channels[0];

      return new Response(JSON.stringify({
        slug: channel.slug,
        name: channel.name,
        keys: Object.keys(channel || {}),
        full: channel,
      }, null, 2), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // Also probe the boot EPG structure
    if (path === "/debug-boot") {
      const clientID = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const bootUrl = `https://boot.pluto.tv/v4/start?appName=web&appVersion=9.21.0-bf9f5b4369933742859f3b2581c935110922f642&deviceVersion=148.0.7778&deviceModel=web&deviceMake=chrome&deviceType=web&clientID=${clientID}&clientModelNumber=1.0.0&serverSideAds=false&clientTime=${encodeURIComponent(timestamp)}`;

      const response = await fetch(bootUrl, {
        cf: { colo: "LAX" },
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "Origin": "https://pluto.tv",
          "Referer": "https://pluto.tv/",
        }
      });

      const data = await response.json();

      return new Response(JSON.stringify({
        epgLength: data.EPG?.length || 0,
        firstEpgChannel: data.EPG?.[0] ? {
          name: data.EPG[0].name,
          slug: data.EPG[0].slug,
          keys: Object.keys(data.EPG[0]),
          timelinesLength: data.EPG[0].timelines?.length || 0,
          firstTimeline: data.EPG[0].timelines?.[0],
        } : null,
        session: data.session,
        stitcher: data.servers?.stitcher,
      }, null, 2), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response(JSON.stringify({
      endpoints: {
        "/debug": "First 3 channels from API",
        "/debug-channel?slug=CHANNEL": "Specific channel details",
        "/debug-boot": "Boot API EPG structure",
      }
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

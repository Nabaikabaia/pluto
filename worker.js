export default {
  async fetch(request) {
    const response = await fetch("https://api.pluto.tv/v2/channels?channelType=live&limit=1", {
      cf: { colo: "LAX" },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Origin": "https://pluto.tv",
        "Referer": "https://pluto.tv/",
      }
    });

    const data = await response.json();
    const firstChannel = Array.isArray(data) ? data[0] : data.data?.[0];

    return new Response(JSON.stringify({
      keys: Object.keys(firstChannel || {}),
      fullObject: firstChannel,
      imagesKeys: firstChannel?.images ? Object.keys(firstChannel.images) : "NO IMAGES",
      tileImage: firstChannel?.tileImage,
      thumbnail: firstChannel?.thumbnail,
      logo: firstChannel?.logo,
    }, null, 2), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
};

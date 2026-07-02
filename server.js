const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TEMP_DIR = "/tmp";

// ============================================
// 🔥 ONE ENDPOINT — CONVERT ANYTHING TO MP4
// ============================================
app.post("/convert", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Missing 'url' in body" });

    const id = uuidv4();
    const ext = path.extname(url).toLowerCase().split("?")[0] || ".unknown";
    const inputFile = path.join(TEMP_DIR, `${id}${ext}`);
    const outputFile = path.join(TEMP_DIR, `${id}.mp4`);

    console.log(`📥 Downloading: ${url}`);

    // Download the file
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = await response.buffer();
    fs.writeFileSync(inputFile, buffer);

    console.log(`🎬 Converting to MP4...`);

    // Convert with ffmpeg
    try {
      execSync(
        `ffmpeg -y -i "${inputFile}" -vf "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -movflags +faststart -pix_fmt yuv420p "${outputFile}"`,
        { timeout: 60000, stdio: "pipe" }
      );
    } catch (ffmpegError) {
      // Fallback: simpler conversion
      execSync(
        `ffmpeg -y -i "${inputFile}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -movflags +faststart "${outputFile}"`,
        { timeout: 60000, stdio: "pipe" }
      );
    }

    // Check if output exists
    if (!fs.existsSync(outputFile)) {
      throw new Error("Conversion failed — no output file");
    }

    const stats = fs.statSync(outputFile);
    console.log(`✅ Converted: ${(stats.size / 1024).toFixed(1)} KB`);

    // Send the file
    res.set("Content-Type", "video/mp4");
    res.set("Content-Length", stats.size);
    res.set("X-Original-Format", ext);
    res.set("X-Converted-Size", stats.size);

    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);

    // Cleanup after sending
    stream.on("end", () => {
      try { fs.unlinkSync(inputFile); } catch (e) {}
      try { fs.unlinkSync(outputFile); } catch (e) {}
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// HEALTH
// ============================================
app.get("/health", (req, res) => {
  try {
    const version = execSync("ffmpeg -version", { timeout: 5000 }).toString().split("\n")[0];
    res.json({ status: "ok", ffmpeg: version });
  } catch (e) {
    res.json({ status: "ok", ffmpeg: "not found (may still work)" });
  }
});

// ============================================
// HOME
// ============================================
app.get("/", (req, res) => {
  const base = `https://${req.get("host")}`;
  res.json({
    service: "Video Converter — Anything to MP4",
    endpoint: `POST ${base}/convert`,
    body: { url: "https://example.com/file.gif" },
    returns: "video/mp4",
    formats: ["gif", "webm", "mov", "avi", "mkv", "flv", "wmv", "ogg", "mp4 (passthrough)"],
    example: `curl -X POST ${base}/convert -H "Content-Type: application/json" -d '{"url":"https://media.giphy.com/media/3o7TKz9b9oYPEQqCbK/giphy.gif"}' -o output.mp4`,
  });
});

// ============================================
// START
// ============================================
app.listen(PORT, () => console.log(`🚀 Video Converter on port ${PORT}`));

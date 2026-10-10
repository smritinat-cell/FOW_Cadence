const { spawn } = require("node:child_process");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { JobError } = require("./ultravox");

function fileHash(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", data => hash.update(data));
    stream.on("error", () => reject(new JobError("DECODE_FAILURE", "The selected sample audio could not be read.")));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function decodeExcerpt(file, offset, length, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(offset), "-i", file, "-t", String(length), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const done = (error, buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (error) { child.kill("SIGKILL"); reject(error); }
      else resolve(buffer);
    };
    const abort = () => done(signal.reason || new JobError("CANCELLED", "Run stopped."));
    const timeout = setTimeout(() => done(new JobError("TIMEOUT", "Audio preparation exceeded its 20-second timeout.")), 20000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    child.on("error", () => done(new JobError("DECODE_FAILURE", "FFmpeg is unavailable or could not decode this audio. Install the configured FFmpeg dependency.")));
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 6400000) done(new JobError("DECODE_FAILURE", "Decoded excerpt exceeds the audio size limit."));
      else chunks.push(chunk);
    });
    child.on("close", code => {
      if (code !== 0) done(new JobError("DECODE_FAILURE", "FFmpeg could not decode the selected sample or excerpt."));
      else if (!bytes) done(new JobError("DECODE_FAILURE", "The requested excerpt contains no audio. Check the start offset and length."));
      else done(null, Buffer.concat(chunks));
    });
  });
}

module.exports = { fileHash, decodeExcerpt };

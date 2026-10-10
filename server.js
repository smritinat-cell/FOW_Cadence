const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createApi } = require("./lib/api");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "artifacts", "speech-prompt-lab");
const DEMO_DIR = path.join(ROOT, "demo-pack");
const UPLOAD_DIR = path.join(ROOT, "attached_assets");
const PORT = Number(process.env.PORT || 5000);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function safeResolve(base, relativePath) {
  const resolved = path.resolve(base, relativePath);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`)
    ? resolved
    : null;
}

function uploadedAudioPath(sample) {
  if (typeof sample.prototype_audio_file !== "string") return null;
  const filePath = safeResolve(UPLOAD_DIR, sample.prototype_audio_file);
  if (!filePath || path.extname(filePath).toLowerCase() !== ".wav") return null;
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : null;
}

function localAudioPath(sample, jsonPath) {
  const audioValue =
    sample.audio_file ??
    sample.audio_path ??
    sample.audio_filename ??
    sample.audio_url ??
    sample.audioUrl ??
    sample.audio;
  const audioPath =
    typeof audioValue === "string"
      ? audioValue
      : audioValue && typeof audioValue === "object"
        ? audioValue.path ?? audioValue.file ?? audioValue.url
        : null;

  if (typeof audioPath === "string" && audioPath.trim()) {
    const normalized = audioPath
      .replace(/^\/demo-pack\//, "")
      .replace(/^demo-pack\//, "");
    const resolved = safeResolve(DEMO_DIR, normalized);
    if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }

  const stem = path.basename(jsonPath, path.extname(jsonPath));
  for (const extension of [".wav", ".mp3", ".m4a", ".ogg", ".webm"]) {
    const candidate = path.join(DEMO_DIR, `${stem}${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function demoJsonFiles() {
  if (!fs.existsSync(DEMO_DIR)) return [];
  return fs
    .readdirSync(DEMO_DIR)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
}

function readDemoSource(filename) {
  const jsonPath = path.join(DEMO_DIR, filename);
  let source;
  try {
    source = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${filename}: ${error.message}`);
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${filename} must contain a JSON object.`);
  }
  return source;
}

function readDemoSamples() {
  return demoJsonFiles().map((filename) => {
    const jsonPath = path.join(DEMO_DIR, filename);
    const source = readDemoSource(filename);
    const audioPath = localAudioPath(source, jsonPath);
    const uploadedAudio = uploadedAudioPath(source);
    const sampleId = String(source.id ?? path.basename(filename, ".json"));
    const speechProfileTags = Array.isArray(source.speech_profile_tags)
      ? source.speech_profile_tags
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
      : [];
    const {
      prototype_audio_file: _prototypeAudioFile,
      ...publicSource
    } = source;
    return {
      ...publicSource,
      // Prototype uploads have a Replit timestamp suffix; retain the source filename.
      audio_filename: typeof source.audio_filename === "string"
        ? path.basename(source.audio_filename)
        : typeof source.prototype_audio_file === "string"
          ? path.basename(source.prototype_audio_file).replace(/_\d{13}(?=\.[^.]+$)/, "")
          : audioPath ? path.basename(audioPath) : null,
      id: sampleId,
      title: source.title ?? source.name ?? "Untitled sample",
      use_case_label: typeof source.use_case_label === "string" ? source.use_case_label : "",
      use_case_summary: typeof source.use_case_summary === "string" ? source.use_case_summary : "",
      agent_name: source.agent_name ?? source.agentName ?? "",
      speech_profile:
        source.speech_profile ??
        source.speechProfile ??
        source.profile ??
        (speechProfileTags.length
          ? speechProfileTags.join(" · ")
          : "Speech profile not specified"),
      speech_profile_tags: speechProfileTags,
      duration_seconds:
        source.duration_seconds ?? source.durationSeconds ?? source.duration ?? null,
      agent_purpose:
        source.agent_purpose ?? source.agentPurpose ?? source.purpose ?? "",
      system_prompt: source.system_prompt ?? source.systemPrompt ?? "",
      reference_transcript:
        source.reference_transcript ??
        source.referenceTranscript ??
        source.transcript ??
        "",
      critical_items: source.critical_items ?? source.criticalItems ?? [],
      reference_material:
        source.reference_material ?? source.referenceMaterial ?? "",
      audio_url: uploadedAudio
        ? `/api/demo-samples/${encodeURIComponent(sampleId)}/audio`
        : audioPath
          ? `/demo-pack/${path.relative(DEMO_DIR, audioPath)
            .split(path.sep)
            .map(encodeURIComponent)
            .join("/")}`
          : null,
    };
  });
}

function findDemoSource(sampleId) {
  for (const filename of demoJsonFiles()) {
    const source = readDemoSource(filename);
    const id = String(source.id ?? path.basename(filename, ".json"));
    if (id === sampleId) return source;
  }
  return null;
}

function byteRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return { invalid: true };
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size || end < start) {
    return { invalid: true };
  }
  return { start, end };
}

function serveUploadedAudio(req, res, sampleId) {
  const source = findDemoSource(sampleId);
  const filePath = source ? uploadedAudioPath(source) : null;
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Sample audio not found");
    return;
  }

  const size = fs.statSync(filePath).size;
  const range = byteRange(req.headers.range, size);
  if (range?.invalid) {
    res.writeHead(416, {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${size}`,
    });
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  res.writeHead(range ? 206 : 200, {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=600",
    "Content-Length": end - start + 1,
    "Content-Type": "audio/wav",
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ??
        "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(contents);
  });
}

const api = createApi(sampleId => {
  const sample = findDemoSource(sampleId);
  return sample ? { sample, file: uploadedAudioPath(sample) || localAudioPath(sample, path.join(DEMO_DIR, `${sampleId}.json`)) } : null;
}, sendJson);

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  } catch {
    sendJson(res, 400, { error: "Invalid request URL." });
    return;
  }
  api.initialize(req, res);

  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/demo-samples" && !/^\/api\/demo-samples\/[^/]+\/audio$/.test(url.pathname)) {
    api.handle(req, res, url);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  if (url.pathname === "/api/demo-samples") {
    try {
      sendJson(res, 200, readDemoSamples());
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  const audioRoute = url.pathname.match(/^\/api\/demo-samples\/([^/]+)\/audio$/);
  if (audioRoute) {
    let sampleId;
    try {
      sampleId = decodeURIComponent(audioRoute[1]);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid sample ID");
      return;
    }
    try {
      serveUploadedAudio(req, res, sampleId);
    } catch {
      sendJson(res, 500, { error: "Sample audio could not be loaded." });
    }
    return;
  }

  if (url.pathname.startsWith("/demo-pack/")) {
    const relativePath = decodeURIComponent(url.pathname.slice("/demo-pack/".length));
    const filePath = safeResolve(DEMO_DIR, relativePath);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Demo asset not found");
      return;
    }
    serveFile(res, filePath);
    return;
  }

  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  let filePath = safeResolve(APP_DIR, relativePath);
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(res, filePath);
    return;
  }

  const indexPath = path.join(APP_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    serveFile(res, indexPath);
  } else {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Speech Prompt Lab is still starting.");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Accessibility Evaluation available on port ${PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  api.jobs.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2500).unref();
});

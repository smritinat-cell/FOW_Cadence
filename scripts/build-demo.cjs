const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "artifacts", "speech-prompt-lab");
const output = path.join(root, "generated-artifacts", "cadence-demo");
const assets = [
  "index.html", "app.js", "styles.css", "cadence-logo.png",
  "simulation.js", "comparison.js", "comparison.css", "transcript-diff.js",
  "demo-flow.js", "comparison-results.json"
];
const samples = JSON.parse(fs.readFileSync(path.join(source, "demo-samples.json"), "utf8"));
const recordings = samples.map(sample => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "demo-pack", `${sample.id}.json`), "utf8"));
  const recording = path.join(root, "attached_assets", path.basename(metadata.prototype_audio_file));
  if (!fs.existsSync(recording)) throw new Error(`Missing recording: ${sample.audio_filename}`);
  return { sample, recording };
});

fs.mkdirSync(path.join(output, "audio"), { recursive: true });
for (const asset of assets) fs.copyFileSync(path.join(source, asset), path.join(output, asset));
const indexPath = path.join(output, "index.html");
let index = fs.readFileSync(indexPath, "utf8").replace('<html lang="en">', '<html lang="en" data-demo="true">');
for (const asset of assets.filter(name => /\.(js|css)$/.test(name))) {
  const revision = crypto.createHash("sha256").update(fs.readFileSync(path.join(output, asset))).digest("hex").slice(0, 12);
  index = index.replaceAll(`"./${asset}"`, `"./${asset}?v=${revision}"`);
}
fs.writeFileSync(indexPath, index);
for (const { sample, recording } of recordings) {
  const filename = path.basename(sample.audio_filename);
  fs.copyFileSync(recording, path.join(output, "audio", filename));
  sample.audio_url = `/audio/${encodeURIComponent(filename)}`;
}
fs.writeFileSync(path.join(output, "demo-samples.json"), JSON.stringify(samples, null, 2) + "\n");
fs.writeFileSync(path.join(output, "vercel.json"), JSON.stringify({ version: 2, framework: null }, null, 2) + "\n");
console.log(`Built saved demo with ${samples.length} recordings in ${path.relative(root, output)}.`);

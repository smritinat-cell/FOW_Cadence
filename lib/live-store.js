const fs = require("node:fs/promises");
const path = require("node:path");

const LIMIT_SECONDS = 24 * 60;
const CAMPAIGN = "recording-comparison-v1";

class FileLiveStore {
  constructor(file) { this.file = file; this.queue = Promise.resolve(); }
  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.data = JSON.parse(await fs.readFile(this.file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = { records: {}, packs: {}, references: {}, reservations: {}, reserved: 0, disabledReason: null };
      await this.flush();
    }
    const maps = [this.data.records, this.data.packs, this.data.reservations];
    const seconds = Object.values(this.data.reservations || {});
    if (maps.some(value => !value || typeof value !== "object" || Array.isArray(value))
      || !Number.isSafeInteger(this.data.reserved) || this.data.reserved < 0 || this.data.reserved > LIMIT_SECONDS
      || seconds.some(value => !Number.isSafeInteger(value) || value <= 0)
      || seconds.reduce((sum, value) => sum + value, 0) !== this.data.reserved) throw new Error("Live cache validation failed.");
  }
  async flush() { await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o600 }); await fs.rename(`${this.file}.tmp`, this.file); }
  mutate(change) {
    const next = this.queue.then(async () => { await change(); await this.flush(); });
    this.queue = next.catch(() => {});
    return next;
  }
  async records() { await this.queue; return structuredClone(Object.values(this.data.records)); }
  async packs() { await this.queue; return structuredClone(Object.values(this.data.packs)); }
  async references() { await this.queue; return structuredClone(Object.values(this.data.references || {})); }
  saveReference(reference) { const snapshot = structuredClone(reference); return this.mutate(() => { this.data.references ||= {}; this.data.references[reference.sampleId] = snapshot; }); }
  save(record) { const snapshot = structuredClone(record); return this.mutate(() => { this.data.records[record.id] = snapshot; }); }
  savePack(pack) { const snapshot = structuredClone(pack); return this.mutate(() => { this.data.packs[pack.id] = snapshot; }); }
  saveMany(records) { const snapshots = structuredClone(records); return this.mutate(() => { for (const record of snapshots) this.data.records[record.id] = record; }); }
  async budget() { await this.queue; return { limitSeconds: LIMIT_SECONDS, reservedSeconds: this.data.reserved, remainingSeconds: Math.max(0, LIMIT_SECONDS - this.data.reserved), disabledReason: this.data.disabledReason }; }
  disable(reason) { return this.mutate(() => { this.data.disabledReason = reason; }); }
  reserve(id, seconds) {
    return this.mutate(() => {
      if (Object.hasOwn(this.data.reservations, id)) return;
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || this.data.disabledReason || this.data.reserved + seconds > LIMIT_SECONDS) throw Object.assign(new Error("Live call budget is unavailable."), { code: "LIVE_BUDGET" });
      this.data.reservations[id] = seconds;
      this.data.reserved += seconds;
    });
  }
  async close() { await this.queue; }
}

function createLiveStore(env = process.env) {
  // The hackathon demo needs no database setup. Published filesystem state is
  // a bounded demo cache; bundled previous results remain available on reset.
  return new FileLiveStore(env.CADENCE_LIVE_STORE_FILE || path.join(__dirname, "..", "var", "live-state.json"));
}

module.exports = { LIMIT_SECONDS, CAMPAIGN, FileLiveStore, createLiveStore };

const crypto = require("node:crypto");
const { JobError } = require("./ultravox");
const COOKIE = "cadence_live";
const MAX_AGE = 8 * 60 * 60;

function equal(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

class LiveAuth {
  constructor({ code = process.env.CADENCE_PRESENTER_CODE || "", secret = process.env.CADENCE_LIVE_SESSION_SECRET || "", local = process.env.CADENCE_LIVE_LOCAL === "1", now = Date.now } = {}) {
    this.code = code; this.secret = secret; this.local = local; this.now = now; this.attempts = new Map();
  }
  protected() { return this.code.length >= 8 && this.secret.length >= 32; }
  configured() { return true; }
  sign(text) { return crypto.createHmac("sha256", this.secret).update(text).digest("hex"); }
  authorized(req, owner) {
    if (!this.protected()) return true;
    const match = String(req.headers.cookie || "").match(/(?:^|;\s*)cadence_live=([0-9]+)\.([a-f0-9]{64})(?:;|$)/);
    if (!match || Number(match[1]) <= Math.floor(this.now() / 1000)) return false;
    return equal(match[2], this.sign(`${owner}:${match[1]}`));
  }
  require(req, owner) { if (!this.authorized(req, owner)) throw new JobError("LIVE_AUTH_REQUIRED", "Presenter access is required.", 401); }
  cookie(res, value, age) {
    const previous = res.getHeader("Set-Cookie");
    const cookies = previous ? Array.isArray(previous) ? previous : [previous] : [];
    res.setHeader("Set-Cookie", [...cookies, `${COOKIE}=${value}; HttpOnly; ${this.local ? "" : "Secure; "}SameSite=Lax; Path=/; Max-Age=${age}`]);
  }
  unlock(req, res, owner, code) {
    if (!this.protected()) return { authorized: true };
    const current = this.now();
    // A global bucket prevents forged forwarding headers from defeating throttling.
    const keys = ["global", owner];
    for (const key of keys) {
      const attempt = this.attempts.get(key);
      if (attempt && current - attempt.at < 300000 && attempt.count >= (key === "global" ? 30 : 5)) throw new JobError("LIVE_AUTH_LIMIT", "Wait before trying presenter access again.", 429);
    }
    if (typeof code !== "string" || code.length > 256 || !equal(code, this.code)) {
      for (const key of keys) {
        const prior = this.attempts.get(key);
        this.attempts.set(key, { at: prior && current - prior.at < 300000 ? prior.at : current, count: prior && current - prior.at < 300000 ? prior.count + 1 : 1 });
      }
      throw new JobError("LIVE_AUTH_REQUIRED", "Presenter access was not accepted.", 401);
    }
    this.attempts.delete(owner);
    const expires = String(Math.floor(current / 1000) + MAX_AGE);
    this.cookie(res, `${expires}.${this.sign(`${owner}:${expires}`)}`, MAX_AGE);
    return { authorized: true, expiresAt: Number(expires) * 1000 };
  }
  end(res) { this.cookie(res, "", 0); return { authorized: false }; }
}

module.exports = { LiveAuth };

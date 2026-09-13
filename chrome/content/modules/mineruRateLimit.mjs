import { sleep } from "./utils.mjs";

// Observed service response: HTTP 429, "50 files/min". Reserve every attempt
// conservatively across clients with the same endpoint and credentials.
export const MINERU_FILES_PER_MINUTE = 50;
const WINDOW_MS = 61_000;

export class MineruRateLimit {
  constructor({ now = () => Date.now(), wait = sleep } = {}) {
    this.now = now;
    this.wait = wait;
    this.reservations = [];
    this.blockedUntil = 0;
  }

  defer(retryAfter) {
    const seconds = Number(retryAfter);
    const requested = retryAfter && Number.isFinite(seconds)
      ? seconds * 1000 : Date.parse(retryAfter) - this.now();
    this.blockedUntil = Math.max(this.blockedUntil,
      this.now() + Math.max(WINDOW_MS, Number.isFinite(requested) ? requested : 0));
  }

  async acquire(count, { shouldAbort = () => false, onProgress = () => {} } = {}) {
    if (!Number.isInteger(count) || count < 0 || count > MINERU_FILES_PER_MINUTE) {
      throw new Error(`MinerU 每批最多提交 ${MINERU_FILES_PER_MINUTE} 个文件。`);
    }
    let previousSeconds = -1;
    for (;;) {
      if (shouldAbort()) throw new Error("操作已取消。");
      const now = this.now();
      this.reservations = this.reservations.filter((entry) => entry.time + WINDOW_MS > now);
      const used = this.reservations.reduce((sum, entry) => sum + entry.count, 0);
      const quotaUntil = count && used + count > MINERU_FILES_PER_MINUTE
        ? this.reservations[0].time + WINDOW_MS : now;
      const remaining = Math.max(this.blockedUntil, quotaUntil) - now;
      if (remaining <= 0) {
        // Atomic quota check/reservation: no await for another caller to interleave.
        if (count) this.reservations.push({ time: now, count });
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      if (seconds !== previousSeconds) {
        onProgress(`MinerU 限流等待… ${seconds} 秒后继续（每分钟最多 50 个文件）`);
        previousSeconds = seconds;
      }
      await this.wait(Math.min(1000, remaining));
    }
  }
}

const sharedLimits = new Map();
export function mineruRateLimitFor(settings) {
  const key = JSON.stringify([String(settings.baseUrl || "").replace(/\/$/, ""), settings.apiKey]);
  if (!sharedLimits.has(key)) sharedLimits.set(key, new MineruRateLimit());
  return sharedLimits.get(key);
}

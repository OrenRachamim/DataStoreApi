import { testHooks } from "./hooks";
import { logEvent } from "./log";
import { dateKey, deleteItemCompletely, KEYS, readIdem, readMeta } from "./store";

export interface ExpiryStats {
  days: string[];
  markers: number;
  itemsDeleted: number;
  itemsSkipped: number;
  staleMarkers: number;
  idemDeleted: number;
  feedbackDeleted: number;
  failures: number;
}

/** Days whose markers are due: the last `lookbackDays` days including today. */
export function dueDays(now: number, lookbackDays = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < lookbackDays; i++) out.push(dateKey(new Date(now - i * 86_400_000).toISOString()));
  return out;
}

/**
 * Daily expiry sweep. Markers are hints; metadata is the truth (DESIGN.md 8).
 * Safe to run twice, safe to run late, tolerant of individual failures.
 */
export async function runExpiry(bucket: R2Bucket, now = Date.now(), pageSize = 1000): Promise<ExpiryStats> {
  const stats: ExpiryStats = { days: dueDays(now), markers: 0, itemsDeleted: 0, itemsSkipped: 0, staleMarkers: 0, idemDeleted: 0, feedbackDeleted: 0, failures: 0 };
  for (const day of stats.days) {
    let cursor: string | undefined;
    do {
      const list = await bucket.list({ prefix: KEYS.expiryPrefix(day), cursor, limit: pageSize });
      for (const obj of list.objects) {
        stats.markers += 1;
        try {
          await processMarker(bucket, obj.key, now, stats);
        } catch (err) {
          stats.failures += 1;
          logEvent("system", { event: "expiry_marker_failed", key: obj.key, error: String((err as Error)?.message ?? err) });
        }
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
  logEvent("system", { event: "expiry_sweep", ...stats });
  return stats;
}

async function processMarker(bucket: R2Bucket, markerKey: string, now: number, stats: ExpiryStats): Promise<void> {
  const name = markerKey.slice(markerKey.lastIndexOf("/") + 1);
  await testHooks.beforeExpiryDelete?.(markerKey);

  if (name.startsWith("itm_")) {
    const cur = await readMeta(bucket, name);
    if (!cur) {
      await bucket.delete(markerKey);
      stats.staleMarkers += 1;
      return;
    }
    if (Date.parse(cur.meta.expiresAt) <= now) {
      await deleteItemCompletely(bucket, name, cur.meta.expiresAt);
      await bucket.delete(markerKey);
      stats.itemsDeleted += 1;
    } else {
      // Extended after this marker was written: the marker is stale, the item stays.
      await bucket.delete(markerKey);
      stats.staleMarkers += 1;
      stats.itemsSkipped += 1;
    }
    return;
  }

  if (name.startsWith("idem~")) {
    const recordKey = name.replace(/~/g, "/");
    const rec = await readIdem(bucket, recordKey);
    if (!rec || Date.parse(rec.createdAt) + 24 * 3600_000 <= now) {
      await bucket.delete([recordKey, markerKey]);
      stats.idemDeleted += 1;
    }
    return;
  }

  if (name.startsWith("fb~")) {
    const recordKey = name.slice(3).replace(/~/g, "/");
    await bucket.delete([recordKey, markerKey]);
    stats.feedbackDeleted += 1;
    return;
  }

  // Unknown marker type: remove it so it does not linger forever.
  await bucket.delete(markerKey);
  stats.staleMarkers += 1;
}

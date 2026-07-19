import { redisClient } from '../config/redis';
import { logger } from '../utils/logger';

interface CacheEnvelope<T> {
  data: T;
  cachedAt: number;
}

/**
 * getOrSet with stale-while-revalidate:
 *  - Cache hit, still fresh (< ttlSeconds old): return immediately.
 *  - Cache hit, stale (older than ttl but within staleSeconds grace window):
 *    return the stale value immediately AND kick off a background refresh,
 *    so the *next* request gets fresh data without any request ever
 *    blocking on the slow upstream (WPGraphQL) call.
 *  - Cache miss: fetch synchronously (unavoidable on the very first call).
 *
 * This is what "handles stale cache invalidation" and "minimises
 * unnecessary requests" (task requirement) actually means in practice -
 * without SWR, every TTL expiry causes a synchronous latency spike for
 * whichever request happens to arrive first.
 */
export async function getOrSetWithSWR<T>(
  key: string,
  ttlSeconds: number,
  staleSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const raw = await redisClient.get(key);

  if (raw) {
    const envelope: CacheEnvelope<T> = JSON.parse(raw);
    const ageSeconds = (Date.now() - envelope.cachedAt) / 1000;

    if (ageSeconds < ttlSeconds) {
      return envelope.data; // fresh
    }

    if (ageSeconds < ttlSeconds + staleSeconds) {
      // stale-but-usable: serve immediately, refresh in background
      refreshInBackground(key, fetcher).catch((err) =>
        logger.error('Background cache refresh failed', { key, error: err.message })
      );
      return envelope.data;
    }
  }

  // Cache miss or too stale to serve - fetch synchronously.
  const fresh = await fetcher();
  await writeCache(key, fresh);
  return fresh;
}

async function refreshInBackground<T>(key: string, fetcher: () => Promise<T>) {
  const fresh = await fetcher();
  await writeCache(key, fresh);
}

async function writeCache<T>(key: string, data: T) {
  const envelope: CacheEnvelope<T> = { data, cachedAt: Date.now() };
  // Redis TTL set generously beyond ttl+stale window; the envelope's own
  // cachedAt timestamp is the real source of truth for freshness.
  await redisClient.set(key, JSON.stringify(envelope), 'EX', 60 * 60 * 6);
}

export async function invalidateCache(key: string) {
  await redisClient.del(key);
}

export async function invalidateCacheByPrefix(prefix: string) {
  const stream = redisClient.scanStream({ match: `${prefix}*` });
  const keys: string[] = [];
  for await (const chunk of stream) {
    keys.push(...(chunk as string[]));
  }
  if (keys.length) await redisClient.del(...keys);
}

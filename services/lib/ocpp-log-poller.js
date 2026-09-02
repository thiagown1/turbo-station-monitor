'use strict';

function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

function createOcppLogPoller(options) {
  const {
    fetchFn,
    baseUrl,
    token,
    processEntry,
    isDuplicate,
    logger = console,
    intervalMs = 5000,
    limit = 1000,
    bootstrapMs = 45_000,
    maxBackoffMs = 60_000,
    requestTimeoutMs = 10_000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setRequestTimeoutFn = setTimeout,
    clearRequestTimeoutFn = clearTimeout,
    now = () => Date.now(),
  } = options;

  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn is required');
  if (typeof processEntry !== 'function') throw new TypeError('processEntry is required');
  if (typeof isDuplicate !== 'function') throw new TypeError('isDuplicate is required');

  let started = false;
  let timer = null;
  let inFlight = null;
  let cursorIso = null;
  let pageCursor = null;
  let recoveryStartIso = null;
  let backoffMs = intervalMs;
  let generation = 0;

  function buildUrl(pathname) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (!cursorIso && !recoveryStartIso) {
      recoveryStartIso = new Date(now() - bootstrapMs).toISOString();
    }
    params.set('start_time', cursorIso || recoveryStartIso);
    if (pathname === '/api/logs/recent' && pageCursor) {
      params.set('cursor', pageCursor);
    }
    return `${baseUrl}${pathname}?${params.toString()}`;
  }

  function parseTimestampMs(value) {
    if (!value) return NaN;
    const text = String(value);
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
    return Date.parse(normalized);
  }

  function cursorAfter(value) {
    const timestampMs = parseTimestampMs(value);
    return Number.isNaN(timestampMs)
      ? null
      : new Date(timestampMs + 1).toISOString();
  }

  async function fetchJsonWithTimeout(url, options) {
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((_resolve, reject) => {
      timeout = setRequestTimeoutFn(() => {
        controller.abort();
        reject(new Error(`REST request timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
    });

    try {
      return await Promise.race([
        (async () => {
          const response = await fetchFn(url, { ...options, signal: controller.signal });
          // Keep the same deadline active through body consumption. Receiving
          // headers is not completion when a server can stall or trickle JSON.
          const body = response.ok ? await response.json() : null;
          return { response, body };
        })(),
        deadline,
      ]);
    } finally {
      clearRequestTimeoutFn(timeout);
    }
  }

  async function fetchRecoveryPage() {
    let result = await fetchJsonWithTimeout(buildUrl('/api/logs/recent'), {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Allows a safe rolling deployment: old OCPP servers do not expose the
    // bounded endpoint yet. Once the server is upgraded, the hot path no longer
    // touches deep history.
    if (result.response.status === 404) {
      result = await fetchJsonWithTimeout(buildUrl('/api/logs/history'), {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return result;
  }

  async function runPoll() {
    const { response, body } = await fetchRecoveryPage();
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'), now());
      const error = new Error(`REST ${response.status}`);
      error.retryAfterMs = retryAfterMs;
      error.status = response.status;
      throw error;
    }

    const entries = body?.data?.entries || [];
    if (!Array.isArray(entries)) throw new Error('REST payload has no entries array');
    const continuityLost = Boolean(body?.data?.truncated);
    const hasMore = Boolean(body?.data?.has_more);
    if (continuityLost) {
      logger.error(
        '[rest-poll] continuity gap: bounded tail did not reach the requested cursor',
      );
    }

    entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    let ingested = 0;
    for (const entry of entries) {
      if (isDuplicate(entry.timestamp, entry.message)) continue;
      processEntry({
        timestamp: entry.timestamp,
        level: entry.level,
        logger: entry.logger,
        message: entry.message,
      });
      ingested += 1;
    }

    const lastTimestamp = entries.at(-1)?.timestamp;
    let nextCursor = cursorAfter(lastTimestamp);
    // Once the page is drained, resume_from also skips scanned raw records that
    // did not match a filter. During pagination it must not jump past entries
    // still advertised by has_more.
    const nextPageCursor = typeof body?.data?.next_cursor === 'string'
      ? body.data.next_cursor
      : null;
    if (!hasMore) {
      pageCursor = null;
      recoveryStartIso = null;
      const resumeCursor = cursorAfter(body?.data?.resume_from);
      if (resumeCursor && (!nextCursor || resumeCursor > nextCursor)) {
        nextCursor = resumeCursor;
      }
      if (nextCursor) cursorIso = nextCursor;
    } else if (nextPageCursor) {
      // Keep the original time anchor while draining this bounded snapshot.
      // The opaque server cursor carries an exclusive timestamp tie-breaker,
      // so equal-millisecond records neither loop nor get skipped.
      pageCursor = nextPageCursor;
    } else {
      // Compatibility with the first rolling-deployment version, which paged
      // only by timestamp. The new server always supplies next_cursor.
      pageCursor = null;
      if (nextCursor) cursorIso = nextCursor;
      recoveryStartIso = null;
    }

    backoffMs = intervalMs;
    if (ingested > 0) {
      logger.log(
        `[rest-poll] ingested ${ingested} entries (${entries.length - ingested} deduped)`,
      );
    }
    return {
      ingested,
      entries: entries.length,
      continuityLost,
      hasMore,
      nextDelayMs: hasMore ? 0 : intervalMs,
    };
  }

  function pollOnce() {
    if (inFlight) return inFlight;
    inFlight = runPoll().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function schedule(delayMs, scheduledGeneration = generation) {
    if (!started || scheduledGeneration !== generation) return;
    timer = setTimeoutFn(async () => {
      let nextDelayMs = intervalMs;
      try {
        const result = await pollOnce();
        nextDelayMs = result.nextDelayMs;
      } catch (error) {
        const retryAfterMs = error.retryAfterMs;
        backoffMs = Math.min(maxBackoffMs, Math.max(intervalMs, backoffMs * 2));
        nextDelayMs = retryAfterMs == null
          ? backoffMs
          : Math.max(intervalMs, retryAfterMs);
        logger.error('[rest-poll] error:', error.message);
      } finally {
        schedule(nextDelayMs, scheduledGeneration);
      }
    }, delayMs);
  }

  function start() {
    if (started) return;
    started = true;
    generation += 1;
    schedule(0, generation);
  }

  function stop() {
    started = false;
    generation += 1;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  return {
    start,
    stop,
    pollOnce,
    isStarted: () => started,
    getCursor: () => cursorIso,
  };
}

module.exports = { createOcppLogPoller, parseRetryAfter };

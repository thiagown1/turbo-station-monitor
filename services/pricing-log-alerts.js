/**
 * Pricing log alert rules (added 2026-11-02).
 *
 * On 2026-11-02 production answered 503 on charge starts for ~6.5 h because
 * the market price catalog expired. The Next app now admits those starts with
 * a fallback price (HTTP 202, so the 5xx alert stays silent) and logs:
 *
 *   [ADMISSION-TARIFF-FALLBACK]  one line per start admitted with the fallback
 *                                price (stationId, original reason, fallback
 *                                price, route; no user PII by contract)
 *   [MARKET-PRICING-ALERT]       pricing pipeline problems (daily apply
 *                                rejected everything, catalog expiring in < 6 h
 *                                or unreadable, watchdog fallback expired)
 *
 * This module holds the pure parts of the two alert rules: the bounded SQL,
 * line parsing, PII redaction and message building. The alert engine wires
 * them into its detection loop, debounce and WhatsApp path.
 *
 * Privacy rule: the WhatsApp message is built ONLY from parsed, whitelisted
 * fields (station id, reason, price, route, kind, summary). Every free-text
 * value goes through redactSensitive() and a length cap, so a log body that
 * accidentally carries an e-mail, user id, token or phone number never reaches
 * the group.
 */

const ADMISSION_FALLBACK_TAG = '[ADMISSION-TARIFF-FALLBACK]';
const MARKET_PRICING_TAG = '[MARKET-PRICING-ALERT]';

const ADMISSION_FALLBACK_ALERT_TYPE = 'admission_tariff_fallback';
const MARKET_PRICING_ALERT_TYPE = 'market_pricing_alert';

const PRICING_ACTION = 'verificar catálogo de preços / rota-api / cron market-pricing';

// Hard cap on rows read per tick. A storm of fallback starts still produces
// one alert; the counts then read as "at least N".
const TAGGED_LOG_ROW_LIMIT = 500;

// Every body match is bounded by a timestamp RANGE so SQLite walks
// idx_vercel_logs_timestamp and only tests instr() on the recent rows. An
// unbounded `body LIKE '%...%'` scans the whole table and times out.
// instr() is a literal substring match: the `[` and `-` in the tags are not
// pattern characters, unlike LIKE's `_` and `%`.
const TAGGED_LOG_QUERY = `
    SELECT id, timestamp, endpoint, body
    FROM vercel_logs
    WHERE timestamp > ?
      AND timestamp <= ?
      AND instr(body, ?) > 0
    ORDER BY timestamp DESC
    LIMIT ?
`;

const MAX_STATIONS_LISTED = 15;
const MAX_REASON_LEN = 80;
const MAX_ROUTE_LEN = 80;
const MAX_SUMMARY_LEN = 300;

/**
 * Read the rows that carry `tag` inside (sinceMs, untilMs]. Never call this
 * without both bounds: they are what keeps the query on the timestamp index.
 */
function queryTaggedVercelLogs(db, tag, sinceMs, untilMs, limit = TAGGED_LOG_ROW_LIMIT) {
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
        throw new Error('queryTaggedVercelLogs requires a finite timestamp range');
    }
    return db.prepare(TAGGED_LOG_QUERY).all(sinceMs, untilMs, tag, limit);
}

// --- Redaction -------------------------------------------------------------

const SENSITIVE_KEY_VALUE = /\b(user[_-]?id|uid|e-?mail|phone|telefone|celular|whatsapp|token|access[_-]?token|id[_-]?token|refresh[_-]?token|authorization|password|senha|cpf|cnpj|customer[_-]?id|api[_-]?key|secret)\b(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g;
const BEARER = /\bBearer\s+\S+/gi;
// 10+ digits with optional separators: phone numbers, CPF, long numeric ids.
const PHONE_LIKE = /\+?\d[\d\s().-]{8,}\d/g;
// ...except a bare calendar date, which pricing logs use for expiry times.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Opaque ids/tokens: 20+ chars mixing letters and digits (Firebase UIDs are 28).
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;

function redactSensitive(text) {
    if (text == null) return '';
    return String(text)
        .replace(SENSITIVE_KEY_VALUE, '$1$2[removido]')
        .replace(JWT, '[token]')
        .replace(BEARER, 'Bearer [token]')
        .replace(EMAIL, '[email]')
        .replace(PHONE_LIKE, (m) => (ISO_DATE.test(m.trim()) ? m : '[número]'))
        .replace(OPAQUE_TOKEN, '[id]');
}

/** Cut on code points (never splits an emoji/surrogate pair) and mark the cut. */
function truncate(text, maxLen) {
    const chars = Array.from(text);
    if (chars.length <= maxLen) return text;
    return `${chars.slice(0, maxLen - 1).join('').trimEnd()}…`;
}

/**
 * Free text → one safe line: redacted, without control characters or
 * WhatsApp markup, whitespace collapsed, capped at maxLen.
 */
function sanitizeText(value, maxLen) {
    if (value == null) return null;
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    const clean = redactSensitive(raw)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/[*~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return null;
    return truncate(clean, maxLen);
}

/** Station ids are whitelisted by shape; anything else is dropped, not shown. */
function sanitizeStationId(value) {
    if (value == null) return null;
    const id = String(value).trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id) ? id : null;
}

function sanitizeKind(value) {
    if (value == null) return null;
    const kind = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return /^[a-z0-9][a-z0-9_.]{0,39}$/.test(kind) ? kind : null;
}

function sanitizePrice(value) {
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 1000) return null;
    return n;
}

function sanitizeRoute(value) {
    if (value == null) return null;
    const route = String(value).trim().split(/[?#]/, 1)[0];
    if (!route.startsWith('/')) return null;
    return sanitizeText(route, MAX_ROUTE_LEN);
}

// --- Parsing ---------------------------------------------------------------

/** Lowercase, strip `_`/`-` so `station_id`, `stationId` and `station-id` match. */
function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[_-]/g, '');
}

/**
 * Text after the tag → { fields, rest }. Accepts a JSON object
 * (`[TAG] {"stationId":"X"}`) or key=value / key: value pairs
 * (`[TAG] stationId=X reason=catalog_expired`).
 */
function parseTaggedLine(body, tag) {
    const text = body == null ? '' : String(body);
    const idx = text.indexOf(tag);
    if (idx < 0) return null;
    const rest = text.slice(idx + tag.length).trim();
    const fields = {};

    const open = rest.indexOf('{');
    const close = rest.lastIndexOf('}');
    if (open >= 0 && close > open) {
        try {
            const obj = JSON.parse(rest.slice(open, close + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                for (const [k, v] of Object.entries(obj)) {
                    if (v == null || typeof v === 'object') continue;
                    fields[normalizeKey(k)] = v;
                }
                return { fields, rest, json: true };
            }
        } catch (_) {
            // Not JSON: fall through to key=value parsing.
        }
    }

    const pair = /([A-Za-z_][A-Za-z0-9_-]*)\s*[=:]\s*("([^"]*)"|'([^']*)'|[^\s,;]+)/g;
    let m;
    while ((m = pair.exec(rest)) !== null) {
        const key = normalizeKey(m[1]);
        if (key in fields) continue;
        fields[key] = m[3] ?? m[4] ?? m[2];
    }
    return { fields, rest, json: false };
}

function pick(fields, keys) {
    for (const key of keys) {
        if (fields[key] != null && fields[key] !== '') return fields[key];
    }
    return null;
}

const UNKNOWN_STATION_KEY = 'sem_station_id';

/** One `[ADMISSION-TARIFF-FALLBACK]` row → whitelisted fields only. */
function parseAdmissionFallbackRow(row) {
    const parsed = parseTaggedLine(row && row.body, ADMISSION_FALLBACK_TAG);
    if (!parsed) return null;
    const f = parsed.fields;
    return {
        id: row.id,
        timestamp: row.timestamp,
        stationId: sanitizeStationId(pick(f, ['stationid', 'station'])),
        reason: sanitizeText(pick(f, ['originalreason', 'reason', 'fallbackreason', 'cause']), MAX_REASON_LEN),
        fallbackPrice: sanitizePrice(pick(f, ['fallbackprice', 'fallbackkwhprice', 'kwhprice', 'price'])),
        route: sanitizeRoute(pick(f, ['route', 'path', 'endpoint'])) || sanitizeRoute(row.endpoint),
    };
}

function incr(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
}

/** Rows → per-station counts, reasons, prices and routes for the window. */
function summarizeAdmissionFallback(rows) {
    const stations = new Map();
    const prices = new Map();
    const routes = new Map();
    const ids = [];
    let latestTs = null;
    let total = 0;

    for (const row of rows || []) {
        const p = parseAdmissionFallbackRow(row);
        if (!p) continue;
        total += 1;
        ids.push(p.id);
        if (typeof p.timestamp === 'number' && (latestTs == null || p.timestamp > latestTs)) latestTs = p.timestamp;
        const key = p.stationId || UNKNOWN_STATION_KEY;
        let s = stations.get(key);
        if (!s) {
            s = { key, stationId: p.stationId, count: 0, reasons: new Map() };
            stations.set(key, s);
        }
        s.count += 1;
        incr(s.reasons, p.reason || 'motivo não informado');
        if (p.fallbackPrice != null) incr(prices, p.fallbackPrice);
        if (p.route) incr(routes, p.route);
    }

    const byCount = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));
    return {
        total,
        latestTs,
        ids,
        stations: [...stations.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
        prices: [...prices.entries()].sort(byCount),
        routes: [...routes.entries()].sort(byCount),
    };
}

function formatBrl(n) {
    return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function formatCounts(entries, render = (k) => k, max = 3) {
    const shown = entries.slice(0, max).map(([k, n]) => `${render(k)} (${n}x)`);
    if (entries.length > max) shown.push(`+${entries.length - max}`);
    return shown.join(', ');
}

/**
 * Build the alert. `newStationKeys` are the stations outside their 1 h
 * cooldown: they are why this alert fires and get a "nova" marker. Stations
 * still in cooldown are listed too, so the message shows the whole window.
 * `lookup` resolves a station id to a display name (station-lookup); a miss
 * just shows the id.
 */
function buildAdmissionFallbackAlert(summary, newStationKeys, { now = Date.now(), lookup = () => null, windowMinutes = 5 } = {}) {
    const fresh = new Set(newStationKeys);
    const lines = [];
    lines.push(
        `${summary.total} início(s) de recarga admitido(s) com preço de fallback nos últimos ${windowMinutes} minutos ` +
        `(HTTP 202: o alerta de 5xx não dispara).`,
    );
    lines.push('');
    lines.push('Estações afetadas:');
    for (const s of summary.stations.slice(0, MAX_STATIONS_LISTED)) {
        let label = s.stationId || 'sem stationId no log';
        if (s.stationId) {
            let name = null;
            try {
                const station = lookup(s.stationId);
                name = station && station.name ? sanitizeText(station.name, 60) : null;
            } catch (_) {
                name = null;
            }
            label = name ? `${name} (${s.stationId})` : s.stationId;
        }
        const reasons = formatCounts([...s.reasons.entries()].sort((a, b) => b[1] - a[1]));
        lines.push(`- ${label}: ${s.count}x · motivo: ${reasons}${fresh.has(s.key) ? ' · nova' : ''}`);
    }
    if (summary.stations.length > MAX_STATIONS_LISTED) {
        lines.push(`- +${summary.stations.length - MAX_STATIONS_LISTED} outra(s) estação(ões)`);
    }
    if (summary.prices.length) lines.push(`Preço de fallback: ${formatCounts(summary.prices, formatBrl)} por kWh`);
    if (summary.routes.length) lines.push(`Rota: ${formatCounts(summary.routes)}`);
    lines.push('');
    lines.push(`⚡ Ação: ${PRICING_ACTION}`);

    return {
        type: ADMISSION_FALLBACK_ALERT_TYPE,
        severity: 'critical',
        // Also copied to the "Turbo Station + URGENTE" group by runDetection.
        urgentCopy: true,
        title: 'URGENTE: recargas admitidas com preço de fallback',
        // Everything material lives in the description: the retry pass
        // rebuilds the message from the stored title/description only.
        description: lines.join('\\n'),
        station_ids: summary.stations.map((s) => s.key),
        new_station_ids: [...fresh],
        count: summary.total,
        vercel_log_ids: JSON.stringify(summary.ids.slice(0, 100)),
        event_ts: summary.latestTs ?? now,
        timestamp: now,
    };
}

// --- Market pricing pipeline -------------------------------------------------

const MARKET_PRICING_KIND_LABELS = {
    daily_apply_rejected: 'aplicação diária rejeitou todos os preços',
    catalog_expiring: 'catálogo de preços expirando em menos de 6 h',
    catalog_unreadable: 'catálogo de preços ilegível',
    watchdog_fallback_expired: 'fallback do watchdog expirou',
    other: 'problema no pipeline de preços',
};

/** Fallback when the line has no explicit kind field. Order matters. */
function inferMarketPricingKind(text) {
    const t = String(text || '');
    if (/watchdog/i.test(t)) return 'watchdog_fallback_expired';
    if (/unreadable|ileg[ií]vel|cannot read|could not read|failed to read|read error|parse/i.test(t)) return 'catalog_unreadable';
    if (/reject|rejeit/i.test(t)) return 'daily_apply_rejected';
    if (/expir/i.test(t)) return 'catalog_expiring';
    return 'other';
}

/** One `[MARKET-PRICING-ALERT]` row → { kind, summary } (both sanitized). */
function parseMarketPricingRow(row) {
    const parsed = parseTaggedLine(row && row.body, MARKET_PRICING_TAG);
    if (!parsed) return null;
    const f = parsed.fields;
    const explicit = sanitizeKind(pick(f, ['kind', 'alert', 'alertkind', 'code', 'type']));
    const textual = pick(f, ['summary', 'message', 'msg', 'detail', 'details']);
    const summarySource = typeof textual === 'string' ? textual : parsed.rest;
    return {
        id: row.id,
        timestamp: row.timestamp,
        kind: explicit || inferMarketPricingKind(parsed.rest),
        summary: sanitizeText(summarySource, MAX_SUMMARY_LEN),
    };
}

/** Rows (newest first) → one group per kind with count and newest summary. */
function groupMarketPricingRows(rows) {
    const groups = new Map();
    for (const row of rows || []) {
        const p = parseMarketPricingRow(row);
        if (!p) continue;
        let g = groups.get(p.kind);
        if (!g) {
            g = { kind: p.kind, count: 0, ids: [], latestTs: null, summary: null };
            groups.set(p.kind, g);
        }
        g.count += 1;
        g.ids.push(p.id);
        if (typeof p.timestamp === 'number' && (g.latestTs == null || p.timestamp > g.latestTs)) {
            g.latestTs = p.timestamp;
            g.summary = p.summary;
        } else if (!g.summary) {
            g.summary = p.summary;
        }
    }
    return [...groups.values()];
}

function buildMarketPricingAlert(group, { now = Date.now(), windowMinutes = 5 } = {}) {
    const label = MARKET_PRICING_KIND_LABELS[group.kind] || group.kind;
    const lines = [
        `Pipeline de preço de mercado: ${label} (${group.count}x nos últimos ${windowMinutes} minutos).`,
        `Tipo: ${group.kind}`,
    ];
    if (group.summary) lines.push(`Log: ${group.summary}`);
    lines.push('');
    lines.push(`⚡ Ação: ${PRICING_ACTION}`);
    return {
        type: MARKET_PRICING_ALERT_TYPE,
        severity: 'critical',
        urgentCopy: true,
        title: 'URGENTE: falha no pipeline de preço de mercado',
        description: lines.join('\\n'),
        kind: group.kind,
        count: group.count,
        vercel_log_ids: JSON.stringify(group.ids.slice(0, 100)),
        event_ts: group.latestTs ?? now,
        timestamp: now,
    };
}

module.exports = {
    ADMISSION_FALLBACK_TAG,
    MARKET_PRICING_TAG,
    ADMISSION_FALLBACK_ALERT_TYPE,
    MARKET_PRICING_ALERT_TYPE,
    PRICING_ACTION,
    TAGGED_LOG_QUERY,
    TAGGED_LOG_ROW_LIMIT,
    UNKNOWN_STATION_KEY,
    queryTaggedVercelLogs,
    redactSensitive,
    sanitizeText,
    parseTaggedLine,
    parseAdmissionFallbackRow,
    summarizeAdmissionFallback,
    buildAdmissionFallbackAlert,
    inferMarketPricingKind,
    parseMarketPricingRow,
    groupMarketPricingRows,
    buildMarketPricingAlert,
};

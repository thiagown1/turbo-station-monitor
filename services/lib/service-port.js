/**
 * Service port resolution — one dedicated env var per service.
 *
 * Why this exists: every service used to read the generic `process.env.PORT`
 * with its own default as a fallback. On a box that runs a dozen services
 * under one pm2 daemon, a single stray `PORT` in the environment (a
 * `pm2 restart <name> --update-env` from a shell that had `PORT` exported,
 * a copy-pasted ecosystem entry) silently rebinds the wrong service.
 *
 * That is not hypothetical. On 2026-07-20 `vercel-drain`, `github-webhook`
 * and `mobile-telemetry` were all running with `PORT=3002`. Two of them bound
 * :3002 at once, so the kernel round-robined incoming connections between
 * them: ~50% of every production Vercel log batch landed on mobile-telemetry,
 * which answered `404 {"error":"Not found"}`. Vercel treats 404 as delivered
 * and never retries, so half of production's logs were lost for as long as the
 * drift lasted. Meanwhile nothing was listening on :3003, so the mobile
 * telemetry ingest returned 502 for every event, and mobile-telemetry
 * crash-looped 27k times on EADDRINUSE without anyone noticing.
 *
 * The rule this module enforces: a service's port comes from ITS OWN env var
 * or its literal default. `PORT` is never consulted. If `PORT` is set at all
 * we log it loudly, because its presence means the drift is happening again.
 *
 * @module services/lib/service-port
 */

/**
 * Default bind address. Every service here sits behind nginx on the same host,
 * so loopback is the correct surface — binding 0.0.0.0 published these
 * services (telemetry ingest, webhook receivers) straight to the internet with
 * only the firewall in front, bypassing the TLS + auth that nginx provides.
 *
 * Override with BIND_HOST only if a service genuinely needs off-box callers.
 */
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

/**
 * Resolve a service's listen port from its dedicated environment variable.
 *
 * @param {string} envVar   Name of the service-specific var, e.g. 'VERCEL_DRAIN_PORT'.
 * @param {number} fallback Port to use when the var is unset.
 * @param {string} logTag   Prefix for warnings, e.g. '[vercel-drain]'.
 * @returns {number} The resolved port.
 * @throws {Error} If the configured value is not a valid TCP port.
 */
function resolveServicePort(envVar, fallback, logTag) {
    const raw = process.env[envVar];
    const port = raw === undefined || raw === '' ? fallback : Number(raw);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(
            `${logTag} Invalid ${envVar}=${JSON.stringify(raw)} — expected an integer TCP port (1-65535)`
        );
    }

    // The generic PORT is never used for binding, but its presence is the
    // fingerprint of the misconfiguration this module exists to prevent.
    const generic = process.env.PORT;
    if (generic !== undefined && generic !== '' && Number(generic) !== port) {
        console.warn(
            `${logTag} Ignoring generic PORT=${generic}; binding ${port} from ${envVar}. ` +
            `A generic PORT in this environment means another service may be misconfigured — ` +
            `run scripts/check-ports.js.`
        );
    }

    return port;
}

module.exports = { resolveServicePort, BIND_HOST };

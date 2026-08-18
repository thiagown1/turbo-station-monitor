const path = require('path');
const fs = require('fs');

// ─── Load .env once and inject into all apps ───
const envPath = path.join(__dirname, '.env');
const dotenv = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      dotenv[key] = val;
    });
}

const CWD = __dirname;

module.exports = {
  apps: [
    {
      // SSE sidecar that tails the mo_simulator stdout (pm2 `mosim` log file)
      // and serves it to the OCPP Simulator dashboard panel via nginx /sim-logs.
      name: 'mosim-logtail',
      script: './services/mosim-logtail/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '80M',
      error_file: './logs/mosim-logtail-error.log',
      out_file: './logs/mosim-logtail-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        ...dotenv,
        LOGTAIL_HOST: dotenv.LOGTAIL_HOST || '127.0.0.1',
        LOGTAIL_PORT: dotenv.LOGTAIL_PORT || 8090,
        // Optional defense-in-depth behind nginx; matches the /sim X-API-Key.
        LOGTAIL_API_KEY: dotenv.SIMULATOR_API_KEY || dotenv.LOGTAIL_API_KEY || '',
      }
    },
    {
      name: 'ocpp-collector',
      script: './services/smart-collector.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      error_file: './logs/collector-error.log',
      out_file: './logs/collector-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv }
    },
    {
      name: 'ocpp-alerts',
      script: './services/alert-processor.js',
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      error_file: './logs/processor-error.log',
      out_file: './logs/processor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv }
    },
    {
      name: 'vercel-drain',
      script: './services/vercel-drain.js',
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      // Stop after 10 rapid restarts instead of looping forever: a port
      // collision (EADDRINUSE) must surface as `errored` in `pm2 ls`, not hide
      // behind a five-figure restart counter. See services/lib/service-port.js.
      max_restarts: 10,
      min_uptime: '30s',
      error_file: './logs/vercel-drain-error.log',
      out_file: './logs/vercel-drain-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, VERCEL_DRAIN_PORT: dotenv.VERCEL_DRAIN_PORT || 3001 }
    },
    {
      name: 'github-webhook',
      script: './services/github-webhook.js',
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      max_restarts: 10,
      min_uptime: '30s',
      error_file: './logs/github-webhook-error.log',
      out_file: './logs/github-webhook-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, GITHUB_WEBHOOK_PORT: dotenv.GITHUB_WEBHOOK_PORT || 3002 }
    },
    {
      name: 'mobile-telemetry',
      script: './services/mobile-telemetry/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      max_restarts: 10,
      min_uptime: '30s',
      error_file: './logs/mobile-telemetry-error.log',
      out_file: './logs/mobile-telemetry-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, MOBILE_TELEMETRY_PORT: dotenv.MOBILE_TELEMETRY_PORT || 3003 }
    },
    {
      name: 'pagarme-status-webhook',
      script: './services/pagarme-status-webhook.js',
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '80M',
      error_file: './logs/pagarme-status-error.log',
      out_file: './logs/pagarme-status-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, PAGARME_WEBHOOK_PORT: dotenv.PAGARME_WEBHOOK_PORT || 3004 }
    },
    {
      name: 'alert-engine',
      script: './services/alert-engine.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      error_file: './logs/alert-engine-error.log',
      out_file: './logs/alert-engine-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv }
    },
    {
      // Private dashboard gateway for the paid ChatGPT/Codex and Claude
      // subscriptions. nginx is the only public edge; the process itself is
      // loopback-only and accepts only two curated, read-only agent profiles.
      name: 'ai-openclaw-agent',
      script: './services/ai-subscription-gateway/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '120M',
      max_restarts: 10,
      min_uptime: '30s',
      error_file: './logs/ai-openclaw-agent-error.log',
      out_file: './logs/ai-openclaw-agent-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        ...dotenv,
        OPENCLAW_AGENT_HOST: '127.0.0.1',
        OPENCLAW_AGENT_PORT: dotenv.OPENCLAW_AGENT_PORT || 3105,
        AI_SUBSCRIPTION_CLAUDE_AGENT_ID:
          dotenv.AI_SUBSCRIPTION_CLAUDE_AGENT_ID || 'ai_dashboard_claude',
        AI_SUBSCRIPTION_CODEX_AGENT_ID:
          dotenv.AI_SUBSCRIPTION_CODEX_AGENT_ID || 'ai_dashboard_codex',
      }
    },
    {
      name: 'support-copilot',
      script: './services/support-copilot/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // 150M sat only ~50MB above the service's own working set, so a single
      // transient — a whole-session read, a base64'd image, a couple of
      // concurrent `openclaw agent` stdout buffers — tripped it and pm2 killed
      // in-flight work (issue #48; 160 restarts, bursts as tight as 11 min).
      //
      // Measured on the live process 2026-08-18 (37 samples / 19 min, taken at
      // 12h uptime with zero restarts in the window): RSS 86-102MB, heap
      // 14-26MB. RSS drifts up within that band with activity rather than
      // sitting flat, but it is not unbounded: at the drift observed in-window
      // the process would have passed 150M inside two hours, and it had been up
      // twelve at 102MB. The restarts were spikes, not a leak.
      //
      // 256M = that ~100MB working set plus headroom for the real transients:
      // media base64 (~25MB for a large image), execFile stdout buffers (5MB
      // each, several may overlap during an alert burst), and the 2MiB
      // session-tail reads. Still tight enough to catch a genuine runaway, and
      // the box has room (16GB total, ~2.2GB across all 40 pm2 processes).
      max_memory_restart: '256M',
      error_file: './logs/support-copilot-error.log',
      out_file: './logs/support-copilot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        ...dotenv,
        SUPPORT_COPILOT_PORT: dotenv.SUPPORT_COPILOT_PORT || 3005,
        EVOLUTION_API_URL: `http://localhost:${dotenv.GATEWAY_PORT || 3006}`,
        EVOLUTION_API_KEY: dotenv.EVOLUTION_API_KEY || '',
        EVOLUTION_WEBHOOK_SECRET: dotenv.EVOLUTION_WEBHOOK_SECRET || '',
        EVOLUTION_INSTANCE_MAP: dotenv.EVOLUTION_INSTANCE_MAP || 'turbo:turbo_station',
      }
    },
    {
      name: 'whatsapp-gateway',
      script: './services/whatsapp-gateway/index.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      error_file: './logs/whatsapp-gateway-error.log',
      out_file: './logs/whatsapp-gateway-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        ...dotenv,
        GATEWAY_PORT: dotenv.GATEWAY_PORT || 3006,
        GATEWAY_AUTH_DIR: path.join(CWD, 'services', 'whatsapp-gateway', 'auth'),
        GATEWAY_WEBHOOK_URL: `http://localhost:${dotenv.SUPPORT_COPILOT_PORT || 3005}/api/support/ingest/evolution`,
        GATEWAY_INSTANCE_NAME: dotenv.GATEWAY_INSTANCE_NAME || 'turbostation',
        EVOLUTION_WEBHOOK_SECRET: dotenv.EVOLUTION_WEBHOOK_SECRET || '',
      }
    },
    {
      name: 'sweep-orchestrator',
      script: './services/sweep-orchestrator.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      max_memory_restart: '150M',
      error_file: './logs/sweep-error.log',
      out_file: './logs/sweep-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv }
    },
    {
      // Nightly vercel.db maintenance: prune rows older than 14 days.
      // cron_restart fires it once at 03:00 UTC; autorestart:false so it runs
      // to completion and exits rather than being kept alive. This entry was
      // MISSING from ecosystem before — the job was pm2-started ad hoc (~2026-07-01)
      // and only lived in the pm2 dump, so `pm2 start ecosystem.config.js` on a
      // fresh box would silently drop it. Pairs with the no-VACUUM / chunked-delete
      // rewrite of scripts/cleanup-vercel.js (fixes the ~18min nightly ingest stall).
      name: 'cleanup-vercel-db',
      script: './scripts/cleanup-vercel.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      cron_restart: '0 3 * * *',
      watch: false,
      max_memory_restart: '150M',
      error_file: './logs/cleanup-vercel-db-error.log',
      out_file: './logs/cleanup-vercel-db-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv }
    }
  ]
};

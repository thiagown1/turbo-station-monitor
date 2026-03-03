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
      error_file: './logs/vercel-drain-error.log',
      out_file: './logs/vercel-drain-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, PORT: dotenv.VERCEL_DRAIN_PORT || 3001 }
    },
    {
      name: 'github-webhook',
      script: './services/github-webhook.js',
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      error_file: './logs/github-webhook-error.log',
      out_file: './logs/github-webhook-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, PORT: dotenv.GITHUB_WEBHOOK_PORT || 3002 }
    },
    {
      name: 'mobile-telemetry',
      script: './services/mobile-telemetry.js',
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      error_file: './logs/mobile-telemetry-error.log',
      out_file: './logs/mobile-telemetry-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, PORT: dotenv.MOBILE_TELEMETRY_PORT || 3003 }
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
      env: { ...dotenv, PORT: dotenv.PAGARME_WEBHOOK_PORT || 3004 }
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
    }
  ]
};

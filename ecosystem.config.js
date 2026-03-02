module.exports = {
  apps: [
    {
      name: 'ocpp-collector',
      script: './services/smart-collector.js',
      cwd: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      error_file: './logs/collector-error.log',
      out_file: './logs/collector-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'ocpp-alerts',
      script: './services/alert-processor.js',
      cwd: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      error_file: './logs/processor-error.log',
      out_file: './logs/processor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'vercel-drain',
      script: './services/vercel-drain.js',
      cwd: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      error_file: './logs/vercel-drain-error.log',
      out_file: './logs/vercel-drain-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        DRAIN_SECRET: '' // Set via: pm2 set vercel-drain:DRAIN_SECRET "your-secret-here"
      }
    },
    {
      name: 'github-webhook',
      script: './services/github-webhook.js',
      cwd: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      error_file: './logs/github-webhook-error.log',
      out_file: './logs/github-webhook-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
        CI_FIX_MAX_ATTEMPTS: 10
      }
    },
    {
      name: 'mobile-telemetry',
      script: './services/mobile-telemetry.js',
      cwd: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      error_file: './logs/mobile-telemetry-error.log',
      out_file: './logs/mobile-telemetry-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3003
      }
    },
    {
      name: 'pagarme-status-webhook',
      script: './services/pagarme-status-webhook.js',
      cwd: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '80M',
      error_file: './logs/pagarme-status-error.log',
      out_file: './logs/pagarme-status-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3004,
        PAGARME_STATUS_TELEGRAM_TARGET: "telegram:-5250194812"
      }
    },
    {
      name: 'alert-engine',
      script: './services/alert-engine.js',
      cwd: '/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      error_file: './logs/alert-engine-error.log',
      out_file: './logs/alert-engine-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        // Send alerts to Telegram alerts group.
        // Target format: telegram:<chat_id>
        ALERT_TELEGRAM_GROUP: 'telegram:-5102620169'
      }
    }
  ]
};

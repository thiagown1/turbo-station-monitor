// Dedicated pm2 ecosystem for the Turbo Station blog services, kept separate
// from the shared ecosystem.config.js so deploys don't touch unrelated apps.
const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '.env');
const dotenv = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if (i === -1) return;
      dotenv[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
}

const CWD = __dirname;

module.exports = {
  apps: [
    {
      name: 'blog-api',
      script: './services/blog-api.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      error_file: './logs/blog-api-error.log',
      out_file: './logs/blog-api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, BLOG_API_PORT: '3300' },
    },
    {
      name: 'blog-generator',
      script: './services/blog-generator.js',
      cwd: CWD,
      instances: 1,
      exec_mode: 'fork',
      // One-shot daily job: pm2 runs it, it generates + exits; cron re-runs it.
      autorestart: false,
      cron_restart: '0 10 * * *', // 10:00 UTC = 07:00 BRT (morning)
      watch: false,
      max_memory_restart: '200M',
      error_file: './logs/blog-generator-error.log',
      out_file: './logs/blog-generator-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      env: { ...dotenv, BLOG_API_BASE_LOCAL: 'http://127.0.0.1:3300' },
    },
  ],
};

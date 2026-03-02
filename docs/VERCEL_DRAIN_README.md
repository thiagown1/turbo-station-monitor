# Vercel Log Drain - Quick Start

## Overview

The Vercel Log Drain webhook receives logs from Vercel deployments and stores them in SQLite for analysis and alerting.

## Files

- `vercel-drain.js` - HTTP webhook server (port 3001)
- `test-vercel-drain.js` - Test script with sample payloads
- `check-vercel-logs.js` - Query recent logs from database

## Quick Start

### 1. Start with PM2 (Production)

```bash
# Start the service
pm2 start ecosystem.config.js --only vercel-drain

# Check status
pm2 status vercel-drain

# View logs
pm2 logs vercel-drain
```

### 2. Manual Start (Development/Testing)

```bash
# Start server
PORT=3001 node vercel-drain.js

# In another terminal, test it
node test-vercel-drain.js

# Check what was saved
node check-vercel-logs.js
```

## Configure Vercel Dashboard

### Step 1: Expose Webhook URL

**Option A: Production (with reverse proxy)**
```nginx
# nginx example
location /vercel-drain {
    proxy_pass http://localhost:3001;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

**Option B: Testing (with ngrok)**
```bash
ngrok http 3001
# Use the HTTPS URL: https://abc123.ngrok.io/vercel-drain
```

### Step 2: Add Log Drain in Vercel

1. Go to: https://vercel.com/[team]/settings/log-drains
2. Click **"Add Log Drain"**
3. Fill in:
   - **Endpoint URL**: `https://your-domain.com/vercel-drain`
   - **Sources**: Select projects (or "All Projects")
   - **Secret**: Generate with `openssl rand -hex 32`
4. Click **"Add Log Drain"**

### Step 3: Configure Secret

```bash
# Set the same secret from Vercel
pm2 set vercel-drain:DRAIN_SECRET "your-secret-here"

# Restart to apply
pm2 restart vercel-drain
```

### Step 4: Verify It's Working

```bash
# Check health endpoint
curl http://localhost:3001/health

# View real-time logs
pm2 logs vercel-drain --lines 50

# Query database
node check-vercel-logs.js
```

## What Gets Filtered Out?

The webhook automatically filters noise to keep your database clean:

- ✋ **308 redirects** (www → non-www)
- ✋ **Favicon requests** (`vercel-favicon/1.0`)
- ✋ **Middleware duplicate logs**
- ✋ **Health check pings** (`/health`, `/ping`)
- ✋ **Uptime monitoring bots**

## What Gets Saved?

✅ **Application logs** with useful data:
- API requests/responses
- Errors (4xx, 5xx status codes)
- High latency requests (>2s)
- Function execution logs
- Memory/CPU metrics

## Monitoring

### Check Stats

```bash
# Via health endpoint
curl http://localhost:3001/health

# Via PM2 logs
pm2 logs vercel-drain | grep Stats
```

**Example output:**
```json
{
  "received": 1523,
  "filtered": 892,
  "saved": 631,
  "errors": 0,
  "filterRate": "58.6%"
}
```

### Database Queries

```bash
# Total Vercel logs
node -e "const db=require('better-sqlite3')('db/logs.db'); \
  console.log(db.prepare('SELECT COUNT(*) FROM logs WHERE source=\"vercel\"').get())"

# Errors today
node -e "const db=require('better-sqlite3')('db/logs.db'); \
  const today=Date.now()-86400000; \
  console.log(db.prepare('SELECT * FROM logs WHERE source=\"vercel\" AND status_code>=400 AND timestamp>?').all(today))"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `DRAIN_SECRET` | _(empty)_ | Vercel webhook signature secret |

## Troubleshooting

### "Invalid signature" errors

```bash
# Make sure secret matches Vercel dashboard
pm2 set vercel-drain:DRAIN_SECRET "correct-secret-here"
pm2 restart vercel-drain
```

### No logs arriving

1. Check Vercel Log Drain status in dashboard
2. Verify webhook URL is accessible: `curl -X POST https://your-domain/vercel-drain`
3. Check PM2 logs: `pm2 logs vercel-drain`
4. Test locally: `node test-vercel-drain.js`

### Database locked errors

```bash
# Check for multiple instances
pm2 list | grep vercel-drain

# Should only show one. If multiple:
pm2 delete vercel-drain
pm2 start ecosystem.config.js --only vercel-drain
```

## Performance

- **Throughput**: ~10,000 logs/second (batch inserts)
- **Latency**: <50ms response time
- **Memory**: ~50-80MB steady state
- **Filter rate**: ~50-60% (varies by project)

## Next Steps

Once logs are flowing:

1. ✅ Phase 3 complete - Vercel logs are being collected
2. ⏳ Phase 4 - Build alert engine to detect issues
3. ⏳ Phase 5 - Add cleanup jobs and monitoring

## Support

- Check INTEGRATION.md for overall project status
- See ecosystem.config.js for PM2 configuration
- View db/logs.db schema in INTEGRATION.md

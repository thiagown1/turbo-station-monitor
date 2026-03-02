# Vercel Log Drain - Deployment Checklist

## Pre-Deployment

- [ ] Database ready: `db/logs.db` exists with correct schema
- [ ] Dependencies installed: `npm install` (better-sqlite3)
- [ ] Port 3001 available (or choose alternative)
- [ ] Firewall allows inbound HTTPS (443) for webhook

## Deployment Steps

### 1. Configure Reverse Proxy

**Example: nginx + certbot**

```bash
# Add to nginx config
sudo nano /etc/nginx/sites-available/your-domain

# Add this location block:
location /vercel-drain {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Disable buffering for real-time logs
    proxy_buffering off;
    
    # Increase timeouts for large payloads
    proxy_read_timeout 60s;
    client_max_body_size 10M;
}

# Test config
sudo nginx -t

# Reload
sudo systemctl reload nginx

# Get SSL cert if needed
sudo certbot --nginx -d your-domain.com
```

**Example: Caddy (automatic HTTPS)**

```caddyfile
# Add to Caddyfile
your-domain.com {
    reverse_proxy /vercel-drain localhost:3001
}

# Reload
sudo systemctl reload caddy
```

### 2. Generate Secret

```bash
# Generate secure random secret
SECRET=$(openssl rand -hex 32)
echo "Save this secret: $SECRET"
```

### 3. Configure PM2

```bash
# Set secret
pm2 set vercel-drain:DRAIN_SECRET "$SECRET"

# Start service
pm2 start ecosystem.config.js --only vercel-drain

# Save PM2 config
pm2 save

# Enable startup script
pm2 startup
```

### 4. Configure Vercel

1. Go to: https://vercel.com/[team]/settings/log-drains
2. Add Log Drain:
   - URL: `https://your-domain.com/vercel-drain`
   - Secret: (paste the $SECRET from step 2)
   - Sources: Select projects
3. Click "Add Log Drain"

### 5. Verify

```bash
# Check PM2 status
pm2 status vercel-drain

# Watch logs in real-time
pm2 logs vercel-drain --lines 0

# Make a request to trigger logs (in your Vercel project)
curl https://your-vercel-app.vercel.app/

# Should see webhook activity within 5-10 seconds

# Check health
curl https://your-domain.com/vercel-drain/health

# Verify database
node check-vercel-logs.js
```

## Post-Deployment

### Monitoring Setup

```bash
# Set up log rotation
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7

# Monitor memory
pm2 monit

# Set up alerts (optional)
pm2 install pm2-slack
```

### Test Failure Scenarios

```bash
# Test with bad secret (should get 401)
curl -X POST https://your-domain.com/vercel-drain \
  -H "x-vercel-signature: sha256=bad-signature" \
  -d '{"test": true}'

# Test with invalid JSON (should handle gracefully)
curl -X POST https://your-domain.com/vercel-drain \
  -d 'not-json'

# Check error count in health
curl https://your-domain.com/vercel-drain/health
```

## Rollback Plan

If something goes wrong:

```bash
# Stop the service
pm2 stop vercel-drain

# Remove Log Drain from Vercel dashboard
# (Settings > Log Drains > Delete)

# Check logs for errors
pm2 logs vercel-drain --err --lines 100

# Restart with verbose logging
PORT=3001 node vercel-drain.js
```

## Checklist Summary

- [ ] Reverse proxy configured with SSL
- [ ] Secret generated and saved securely
- [ ] PM2 service started and saved
- [ ] PM2 startup script enabled
- [ ] Vercel Log Drain added in dashboard
- [ ] Webhook receiving logs (check PM2 logs)
- [ ] Database populating (check with `check-vercel-logs.js`)
- [ ] Health endpoint accessible
- [ ] Log rotation configured
- [ ] Monitoring in place

## Expected Behavior

**First 5 minutes:**
- Logs should start flowing immediately
- ~50-60% filtered (varies by project)
- Memory ~50-80MB
- Response time <50ms

**After 24 hours:**
- Database size: ~15-30MB (varies by traffic)
- Filter rate stabilizes
- No memory growth (stable)

## Support Contacts

- Vercel Status: https://www.vercel-status.com/
- PM2 Docs: https://pm2.keymetrics.io/docs/
- SQLite Docs: https://www.sqlite.org/docs.html

---

**Last Updated**: 2026-02-12  
**Version**: 1.0.0  
**Status**: ✅ Ready for Production

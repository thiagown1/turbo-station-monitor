# Cron Setup for Database Maintenance

## Automatic Setup (when cron is available)

Run the setup script:
```bash
cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor
./setup-cron.sh
```

## Manual Setup

If crontab is not available or you prefer manual setup:

### Option 1: User Crontab

1. Edit crontab:
```bash
crontab -e
```

2. Add this line (runs at 03:00 BRT / 06:00 UTC daily):
```cron
0 6 * * * cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor && /usr/bin/node daily-maintenance.js >> logs/maintenance.log 2>&1
```

3. Verify:
```bash
crontab -l
```

### Option 2: PM2 Cron Module

If using PM2 (already in use for OCPP monitor):

```bash
pm2 install pm2-cron
```

Then add to `ecosystem.config.js`:
```javascript
{
  name: 'db-maintenance',
  script: 'daily-maintenance.js',
  cron_restart: '0 6 * * *',  // 06:00 UTC = 03:00 BRT
  autorestart: false
}
```

### Option 3: Systemd Timer (Linux)

Create `/etc/systemd/system/ocpp-db-maintenance.service`:
```ini
[Unit]
Description=OCPP Database Maintenance
After=network.target

[Service]
Type=oneshot
User=openclaw
WorkingDirectory=/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor
ExecStart=/usr/bin/node daily-maintenance.js
StandardOutput=append:/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/logs/maintenance.log
StandardError=append:/home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/logs/maintenance.log
```

Create `/etc/systemd/system/ocpp-db-maintenance.timer`:
```ini
[Unit]
Description=Daily OCPP Database Maintenance
Requires=ocpp-db-maintenance.service

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable ocpp-db-maintenance.timer
sudo systemctl start ocpp-db-maintenance.timer
sudo systemctl status ocpp-db-maintenance.timer
```

## Timezone Notes

- **BRT (Brasília Time):** UTC-3
- **03:00 BRT = 06:00 UTC**
- Cron runs in system timezone (currently UTC)
- Adjust cron time if server timezone changes

## Verification

Check if cron is running:
```bash
# Verify crontab entry
crontab -l | grep maintenance

# Check recent logs
tail -f logs/maintenance.log

# Manual test
node daily-maintenance.js
```

## Troubleshooting

**Cron not running?**
- Check cron service: `systemctl status cron` or `service crond status`
- Check system logs: `grep CRON /var/log/syslog`

**Script failing in cron?**
- Cron has limited environment variables
- Always use absolute paths in cron jobs
- Check logs in `logs/maintenance.log`

**Need different schedule?**
- Edit cron time (crontab format: `minute hour day month weekday`)
- Examples:
  - `0 */6 * * *` - Every 6 hours
  - `0 3 * * 0` - Weekly on Sunday at 03:00
  - `0 3 1 * *` - Monthly on 1st at 03:00

#!/bin/bash
# Setup script for Vercel Log Drain webhook
# Run with: sudo bash setup-webhook.sh

set -e

echo "🔧 Installing nginx and certbot..."
apt update
apt install -y nginx certbot python3-certbot-nginx

echo ""
echo "📝 Creating nginx configuration..."
cp /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor/nginx-config.conf /etc/nginx/sites-available/logs.turbostation.com.br

echo ""
echo "🔗 Creating symlink..."
ln -sf /etc/nginx/sites-available/logs.turbostation.com.br /etc/nginx/sites-enabled/

echo ""
echo "✅ Testing nginx configuration..."
nginx -t

echo ""
echo "🔄 Reloading nginx..."
systemctl reload nginx

echo ""
echo "🔐 Generating SSL certificate..."
certbot --nginx -d logs.turbostation.com.br --non-interactive --agree-tos --email thiago@turbostation.com.br

echo ""
echo "🔑 Setting up webhook secret..."
SECRET="1c661c8de0e251d7c240e0877208089178c8602b6e1d82982d2b30459f8682ca"
cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor
su - openclaw -c "/home/openclaw/.npm-global/bin/pm2 set vercel-drain:DRAIN_SECRET '$SECRET'"

echo ""
echo "🚀 Starting webhook service..."
su - openclaw -c "cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor && /home/openclaw/.npm-global/bin/pm2 start ecosystem.config.js --only vercel-drain"
su - openclaw -c "/home/openclaw/.npm-global/bin/pm2 save"

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Configuration Summary:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "URL: https://logs.turbostation.com.br"
echo "Secret: $SECRET"
echo ""
echo "🔹 Add this to Vercel Log Drain configuration:"
echo "   URL: https://logs.turbostation.com.br"
echo "   Secret: $SECRET"
echo ""
echo "🔹 Test the endpoint:"
echo "   curl https://logs.turbostation.com.br/health"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

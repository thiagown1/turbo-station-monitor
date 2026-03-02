#!/usr/bin/env node
/**
 * top-charging-now.js
 * 
 * Identifica estações carregando agora e envia notificação ao WhatsApp
 */

const fs = require('fs');
const path = require('path');
const { lookupStation } = require('./station-lookup');

const CHARGERS_FILE = path.join(__dirname, 'history/chargers.json');

function getChargingNow() {
    const data = JSON.parse(fs.readFileSync(CHARGERS_FILE));
    const now = Date.now();
    const results = [];

    Object.values(data).forEach(c => {
        const station = lookupStation(c.id);
        if (!station) return;

        if (c.status === 'Charging') {
            const lastEvent = new Date(c.lastEvent || c.lastHeartbeat).getTime();
            const minutesAgo = Math.round((now - lastEvent) / 1000 / 60);
            
            results.push({
                id: c.id,
                name: station.name,
                location: station.location,
                powerKw: station.powerKw,
                minutesAgo
            });
        }
    });

    // Sort by power capacity (proxy for actual injection)
    results.sort((a, b) => b.powerKw - a.powerKw);
    return results;
}

function formatMessage(iteration) {
    const charging = getChargingNow();
    const emojis = ['🔥', '⚡', '🏁'];
    const emoji = emojis[iteration - 1] || '⚡';
    
    const time = new Date().toLocaleTimeString('pt-BR', { 
        hour: '2-digit', 
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'America/Sao_Paulo'
    });

    let msg = `${emoji} *TOP CARGA EM TEMPO REAL* (${iteration}/3)\n`;
    msg += `🕐 ${time}\n\n`;

    if (charging.length === 0) {
        msg += '😴 Nenhuma estação carregando agora';
        return msg;
    }

    const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    charging.slice(0, 5).forEach((c, i) => {
        msg += `${medal[i] || '•'} *${c.name}*\n`;
        msg += `   ⚡ ${c.powerKw} kW · 📍 ${c.location}\n`;
    });

    msg += `\n📊 *${charging.length}* estações carregando agora`;
    
    return msg;
}

// Output for use by caller
const iteration = parseInt(process.argv[2] || '1');
console.log(formatMessage(iteration));

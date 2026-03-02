#!/usr/bin/env node
/**
 * format-status-whatsapp.js
 * 
 * Formata status geral da rede OCPP para WhatsApp
 */

const fs = require('fs');
const path = require('path');
const { lookupStation } = require('./station-lookup');

const CHARGERS_FILE = path.join(__dirname, 'history/chargers.json');

function getStatusSummary() {
    const data = JSON.parse(fs.readFileSync(CHARGERS_FILE));
    
    let total = 0;
    let available = 0;
    let charging = 0;
    let needsRestart = 0;
    let offline = 0;
    
    const chargingList = [];
    const problemList = [];
    
    const now = Date.now();
    
    // Filter: only count "real" chargers (have station lookup OR recent activity)
    Object.values(data).forEach(c => {
        const station = lookupStation(c.id);
        const lastHB = new Date(c.lastHeartbeat).getTime();
        const minutesSinceHB = (now - lastHB) / 1000 / 60;
        
        // Check if charger is actually active (sending data even without heartbeat)
        const lastMV = c.lastMeterValue ? new Date(c.lastMeterValue).getTime() : 0;
        const minutesSinceMV = (now - lastMV) / 1000 / 60;
        const isActivelyCharging = c.status === 'Charging' || c.activeTransaction || minutesSinceMV <= 5;
        
        // Skip if: numeric ID AND no station mapping AND offline >24h
        if (/^\d+$/.test(c.id) && !station && minutesSinceHB > 1440) {
            return;
        }
        
        total++;
        
        // Check offline (>30min) - BUT ignore if actively charging (some don't send heartbeat during charge)
        if (minutesSinceHB > 30 && !isActivelyCharging) {
            offline++;
            // Only add to problem list if it has a name
            if (station) {
                problemList.push({
                    id: c.id,
                    name: station.name,
                    issue: 'Offline (>30min)'
                });
            }
        }
        
        if (c.needsRestart && minutesSinceHB <= 30) {
            needsRestart++;
            problemList.push({
                id: c.id,
                name: station ? station.name : c.id,
                issue: c.restartReason
            });
        }
        
        if (c.status === 'Available') available++;
        else if (c.status === 'Charging') {
            charging++;
            chargingList.push(station ? station.name : c.id);
        }
    });
    
    return {
        total,
        available,
        charging,
        needsRestart,
        offline,
        chargingList,
        problemList
    };
}

function formatForWhatsApp() {
    const stats = getStatusSummary();
    
    let msg = '📊 *STATUS REDE TURBO STATION*\n\n';
    
    // Status geral - baseado em problemas REAIS (com nome)
    const realProblems = stats.problemList.length;
    
    if (realProblems === 0) {
        msg += '✅ *TUDO OK!*\n\n';
    } else if (realProblems <= 2) {
        msg += '⚠️ *Atenção Minor*\n\n';
    } else {
        msg += '🔴 *Problemas Detectados*\n\n';
    }
    
    // Números principais
    msg += `📡 *${stats.total}* carregadores\n`;
    msg += `🟢 *${stats.available}* disponíveis\n`;
    
    if (stats.charging > 0) {
        msg += `🔋 *${stats.charging}* em uso\n`;
    }
    
    if (realProblems > 0) {
        msg += `⚠️ *${realProblems}* com problema\n`;
    }
    
    // Carregadores em uso
    if (stats.chargingList.length > 0) {
        msg += `\n💚 *Em Uso Agora:*\n`;
        stats.chargingList.forEach(name => {
            msg += `  • ${name}\n`;
        });
    }
    
    // Problemas
    if (stats.problemList.length > 0) {
        msg += `\n⚠️ *Atenção Necessária:*\n`;
        stats.problemList.slice(0, 5).forEach(p => {
            msg += `  • ${p.name}\n    ↳ _${p.issue}_\n`;
        });
        
        if (stats.problemList.length > 5) {
            msg += `  _...e mais ${stats.problemList.length - 5}_\n`;
        }
    }
    
    // Footer
    const now = new Date();
    const time = now.toLocaleTimeString('pt-BR', { 
        hour: '2-digit', 
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo'
    });
    
    msg += `\n🕐 Atualizado ${time}`;
    
    return msg;
}

// Run if called directly
if (require.main === module) {
    console.log(formatForWhatsApp());
}

module.exports = { getStatusSummary, formatForWhatsApp };

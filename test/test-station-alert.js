#!/usr/bin/env node
/**
 * test-station-alert.js
 * 
 * Testa formatação de alertas com lookup de estações
 */

const fs = require('fs');
const path = require('path');

// Simular a função formatAlertMessage
const { lookupStation } = require('./station-lookup');

function analyzeAlert(alert) {
    const { type, severity } = alert;

    let emoji = '🟡';
    let title = 'Alerta OCPP';
    let action = '';

    switch (severity) {
        case 'critical':
            emoji = '🔴';
            break;
        case 'error':
            emoji = '🟠';
            break;
        case 'warning':
            emoji = '🟡';
            break;
        default:
            emoji = 'ℹ️';
    }

    switch (type) {
        case 'charger_needs_restart':
            title = 'Carregador precisa de restart';
            action = '♻️ Ação: Reiniciar via plataforma ou fisicamente';
            break;
        case 'charger_faulted':
            title = 'Carregador em FALHA';
            action = '⚡ Ação: Reiniciar remotamente via plataforma';
            break;
        case 'charger_recovered':
            emoji = '✅';
            title = 'Carregador RECUPERADO';
            action = '👍 Estação voltou ao normal';
            break;
        default:
            title = 'Erro OCPP';
    }

    return { emoji, title, action };
}

function formatAlertMessage(alert) {
    const { emoji, title, action } = analyzeAlert(alert);
    const { chargerId, message, timestamp } = alert;

    const time = new Date(timestamp).toLocaleTimeString('pt-BR', { 
        hour: '2-digit', 
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo'
    });

    let msg = `${emoji} *${title}*\n\n`;
    
    // Lookup station info
    const station = chargerId ? lookupStation(chargerId) : null;
    
    if (station) {
        // Rich format with station name and location
        msg += `🏢 *${station.name}*\n`;
        msg += `📍 ${station.location}\n`;
        msg += `🆔 ${chargerId}\n\n`;
    } else if (chargerId) {
        // Fallback: just charger ID
        msg += `🔌 *Carregador: ${chargerId}*\n\n`;
    } else {
        msg += `⚠️ Carregador desconhecido\n\n`;
    }

    msg += `📝 ${message}\n`;
    msg += `🕐 ${time}\n`;

    if (action) {
        msg += `\n${action}`;
    }

    return msg;
}

// Test cases
const tests = [
    {
        type: 'charger_needs_restart',
        severity: 'critical',
        chargerId: 'AR2510070008',
        message: '3 erros consecutivos',
        timestamp: new Date().toISOString()
    },
    {
        type: 'charger_faulted',
        severity: 'critical',
        chargerId: 'GO2508130004',
        message: 'Status: Faulted',
        timestamp: new Date().toISOString()
    },
    {
        type: 'charger_recovered',
        severity: 'info',
        chargerId: '124030001957',
        message: 'Carregador voltou ao status Available',
        timestamp: new Date().toISOString()
    },
    {
        type: 'charger_needs_restart',
        severity: 'critical',
        chargerId: 'UNKNOWN_ID_12345',
        message: 'Heartbeat timeout (>5min)',
        timestamp: new Date().toISOString()
    }
];

console.log('🧪 Testando formatação de alertas com lookup de estações\n');
console.log('='.repeat(70));

tests.forEach((test, i) => {
    console.log(`\nTeste ${i + 1}: ${test.type} - ${test.chargerId}`);
    console.log('-'.repeat(70));
    const formatted = formatAlertMessage(test);
    console.log(formatted);
    console.log('='.repeat(70));
});

const fetch = require('node-fetch');
const { exec } = require('child_process');
const { formatForWhatsApp } = require('../whatsapp-formatter/formatter');

// Config
const API_URL = 'https://logs.ocpp.turbostation.com.br/api/logs/history';
const TARGET_GROUP = '120363423472541295@g.us';

async function generateReport() {
    // 1. Buscar erros da última hora
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const url = `${API_URL}?level=ERROR&start_time=${oneHourAgo}&limit=20`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (!data.success) throw new Error("Falha na API");
        
        const errors = data.data.entries;
        
        let report = "";
        
        if (errors.length === 0) {
            report = "✅ *Sistema OCPP Estável*\nNenhum erro registrado na última hora.";
        } else {
            // Resumir erros (simples por enquanto)
            const uniqueLoggers = [...new Set(errors.map(e => e.logger))];
            report = `⚠️ *Relatório de Estabilidade*\n\nEncontramos *${errors.length} erros* na última hora.\n\n📍 *Origem:* ${uniqueLoggers.join(', ')}\n\n🔍 *Último Erro:*\n_${errors[0].message.substring(0, 100)}_`;
        }

        // Enviar
        sendWhatsApp(report);
        
    } catch (e) {
        console.error(e);
    }
}

function sendWhatsApp(text) {
    const safeText = JSON.stringify(text);
    const cmd = `openclaw message send --action send --channel whatsapp --to "${TARGET_GROUP}" --message ${safeText}`;
    exec(cmd);
}

generateReport();

const fetch = require('node-fetch');

const API_URL = 'https://logs.ocpp.turbostation.com.br/api/logs/history';

async function checkVolume() {
    // Últimos 5 minutos
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const url = `${API_URL}?start_time=${fiveMinAgo}&limit=1000`;

    const res = await fetch(url);
    const data = await res.json();
    const logs = data.data.entries;

    console.log(`📊 Total Logs (5 min): ${logs.length}`);

    // Simular Filtro
    const filtered = logs.filter(l => !l.message.includes('Heartbeat'));
    console.log(`📉 Logs Úteis (sem Heartbeat): ${filtered.length}`);
    
    console.log('\n--- Amostra Útil ---');
    filtered.slice(0, 5).forEach(l => console.log(`[${l.level}] ${l.message.substring(0, 80)}...`));
}

checkVolume();

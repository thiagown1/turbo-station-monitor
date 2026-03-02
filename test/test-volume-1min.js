const fetch = require('node-fetch');

const API_URL = 'https://logs.ocpp.turbostation.com.br/api/logs/history';

async function checkVolumeAggressive() {
    // Último 1 minuto
    const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    const url = `${API_URL}?start_time=${oneMinAgo}&limit=1000`;

    const res = await fetch(url);
    const data = await res.json();
    const logs = data.data.entries;

    console.log(`📊 Total Logs (1 min): ${logs.length}`);

    // Filtro Agressivo
    const filtered = logs.filter(l => {
        // Manter ERROR e WARNING
        if (['ERROR', 'WARNING', 'CRITICAL'].includes(l.level)) return true;
        
        // No INFO, descartar ruído conhecido
        const msg = l.message;
        if (msg.includes('Heartbeat')) return false;
        if (msg.includes('MeterValues')) return false;
        if (msg.includes('Updated battery percentage')) return false;
        if (msg.includes('send [')) return false; // Protocolo cru
        if (msg.includes('receive message')) return false; // Protocolo cru
        
        return true; // Mantém outros INFOs (StatusNotification, Boot, etc)
    });

    console.log(`📉 Logs Relevantes (Filtro Agressivo): ${filtered.length}`);
    
    if (filtered.length > 0) {
        console.log('\n--- O Que Sobrou (Relevante) ---');
        filtered.slice(0, 10).forEach(l => console.log(`[${l.level}] ${l.logger}: ${l.message.substring(0, 80)}...`));
    } else {
        console.log('\n✅ Nenhum erro ou evento relevante no último minuto.');
    }
}

checkVolumeAggressive();

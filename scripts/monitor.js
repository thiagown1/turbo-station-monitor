const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');

// Configuração
const WS_URL = 'wss://logs.ocpp.turbostation.com.br/dashboard/ws/';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXNoYm9hcmRfaWQiOiJvcGVuY2xhdy1tb25pdG9yIiwicm9sZSI6Im1vbml0b3IiLCJwZXJtaXNzaW9ucyI6WyJsb2dzLnJlYWQiLCJsb2dzLmZpbHRlciJdLCJpYXQiOjE3NzA4MTcxOTAsImlzcyI6Im9jcHAtc2VydmVyIiwic3ViIjoib3BlbmNsYXctbW9uaXRvciJ9.toiKVkIbGcmeVx-RRQh7Zt8lXLCbfFDGqyC9qbYoAPM';

// Cache para Debounce (Anti-Spam)
const sentAlerts = new Map();
const DEBOUNCE_TIME = 60 * 60 * 1000; // 1 hora sem repetir o mesmo erro exato

function connect() {
    const subprotocol = `dashboard-logs.${TOKEN}`;
    const ws = new WebSocket(WS_URL, subprotocol);

    ws.on('open', () => {
        console.log('✅ Conectado ao monitor de logs OCPP');
        
        const filterMsg = {
            type: 'filter_update',
            data: {
                levels: ['WARNING', 'ERROR', 'CRITICAL']
            }
        };
        ws.send(JSON.stringify(filterMsg));
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'log_entry') {
                handleLogEntry(msg.data);
            }
        } catch (e) {
            console.error('Erro ao processar mensagem:', e);
        }
    });

    ws.on('close', () => {
        console.log('⚠️ Desconectado. Reconectando em 5s...');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        console.error('Erro no WebSocket:', err.message);
        ws.close();
    });
}

function handleLogEntry(entry) {
    // Chave única do erro (Logger + Mensagem)
    const errorKey = `${entry.logger}:${entry.message}`;
    const now = Date.now();

    // Verifica se já enviamos esse erro recentemente
    if (sentAlerts.has(errorKey)) {
        const lastSent = sentAlerts.get(errorKey);
        if (now - lastSent < DEBOUNCE_TIME) {
            console.log(`🔇 Alerta silenciado (debounce): ${errorKey}`);
            return;
        }
    }

    // Atualiza timestamp do último envio
    sentAlerts.set(errorKey, now);

    // Chama o Analista Inteligente (analyze.js)
    const analyzeScript = path.join(__dirname, 'analyze.js');
    // Passa o log como JSON string escapada
    const logJSON = JSON.stringify(entry).replace(/"/g, '\\"');
    
    const cmd = `node "${analyzeScript}" "${logJSON}"`;

    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error(`Erro na análise: ${error.message}`);
            return;
        }
        console.log(`✅ Alerta processado: ${entry.logger}`);
    });
}

// Limpar cache antigo a cada hora
setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of sentAlerts.entries()) {
        if (now - timestamp > DEBOUNCE_TIME) {
            sentAlerts.delete(key);
        }
    }
}, 60 * 60 * 1000);

connect();

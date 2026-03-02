// Test script to manually trigger a recovery alert for 814030001959
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const WHATSAPP_GROUP = '120363423472541295@g.us';

// Simulate recovery alert
const recoveryAlert = {
    type: 'charger_recovered',
    severity: 'info',
    chargerId: '814030001959',
    message: 'Carregador recuperado: Faulted → Available',
    timestamp: new Date().toISOString(),
    rawLog: {
        message: 'StatusNotification: status=Available, error_code=NoError',
        logger: 'charger_814030001959'
    }
};

// Format the alert
const time = new Date().toLocaleTimeString('pt-BR', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo'
});

const message = `✅ *Carregador RECUPERADO*

🔌 *Carregador: 814030001959*

📝 ${recoveryAlert.message}

🕐 ${time}

👍 Estação voltou ao normal`;

console.log('📱 Enviando alerta de recuperação...\n');
console.log(message);
console.log('\n---\n');

// Send via OpenClaw
const escapedMsg = message.replace(/'/g, "'\\''");
const cmd = `openclaw message send --channel whatsapp --target '${WHATSAPP_GROUP}' --message '${escapedMsg}'`;

exec(cmd, (error, stdout, stderr) => {
    if (error) {
        console.error(`❌ Erro: ${error.message}`);
        console.error(`stderr: ${stderr}`);
        return;
    }
    console.log('✅ Alerta de recuperação enviado!');
});

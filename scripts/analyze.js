const { exec } = require('child_process');
const fs = require('fs');

// Recebe o log como argumento
const logDataJSON = process.argv[2];
if (!logDataJSON) process.exit(1);

let logData;
try {
    logData = JSON.parse(logDataJSON);
} catch (e) {
    console.error("Invalid JSON");
    process.exit(1);
}

// Prompt para o Analista Jr. (Gemini Flash Lite)
const prompt = `
Você é um Analista de Suporte Nível 1 para um servidor OCPP de carregadores de veículos elétricos.
Analise o seguinte log de erro:

LOGGER: ${logData.logger}
NÍVEL: ${logData.level}
MENSAGEM: ${logData.message}
TIMESTAMP: ${logData.timestamp}

Sua tarefa:
1. Ignore se for apenas ruído técnico sem impacto (ex: heartbeat perdido isolado).
2. Se for relevante, RESUMA o problema em 1 frase simples e direta para um humano ler no WhatsApp.
3. Classifique a severidade: 🟡 (Aviso), 🟠 (Erro), 🔴 (Crítico).
4. Formate a saída EXATAMENTE assim:

[SEVERIDADE_EMOJI] *[Resumo Curto]*
📝 Detalhe: [Explicação técnica breve]
📍 Origem: ${logData.logger}
`;

// Executar Agente (simulado via call direto ou script auxiliar)
// Por simplicidade e performance, vamos usar uma lógica local por enquanto,
// mas aqui você poderia chamar 'openclaw agent run' se tivesse permissão.

// MODO SIMPLIFICADO (sem gastar tokens de agente por enquanto, para validar o fluxo):
// Se quiser ativar a IA real, descomente a chamada de API.

const emoji = logData.level === 'CRITICAL' ? '🔴' : '🟠';
const message = `${emoji} *Erro no Servidor OCPP*

📝 ${logData.message.substring(0, 200)}${logData.message.length > 200 ? '...' : ''}
📍 \`${logData.logger}\`
🕐 ${logData.timestamp}`;

// Enviar alerta
const target = '120363423472541295@g.us';
// Usando JSON stringify para escapar caracteres perigosos no shell
const safeMessage = JSON.stringify(message);

// Comando corrigido para o CLI do OpenClaw
const cmd = `openclaw message send --action send --channel whatsapp --to "${target}" --message ${safeMessage}`;

exec(cmd, (error, stdout, stderr) => {
    if (error) {
        console.error(`Erro ao enviar: ${error.message}`);
        return;
    }
    console.log("Alerta enviado com sucesso.");
});

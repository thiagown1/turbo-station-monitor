# Alertas Detalhados: Faulted + Recovery

## Problema

Dois issues identificados por Thiago:

### 1. "Faulted pelo o que?"
Alerta dizia apenas:
```
🔴 Carregador em FALHA
Status: Faulted
```

**Sem contexto**: Qual foi o erro? Por que falhou?

### 2. "Ele já normalizou e não recebemos essa informação"
Carregador GO2508130004:
- Faulted às 23:08 (4h atrás)
- Recuperado às 02:57 (Available, sem erros)
- **Nenhum alerta de recuperação foi enviado**

## Solução

### 1. Captura de Detalhes do Erro (Faulted)

Quando detecta `StatusNotification: Faulted`, agora captura:

```javascript
// Extract error details
const errorCodeMatch = msg.match(/error_code[=:]?\s*([A-Za-z]+)/);
const vendorErrorMatch = msg.match(/vendor_error_code[=:]?\s*['"]([^'"]+)['"]/);

let faultDetails = 'Status: Faulted';
if (errorCodeMatch) {
    faultDetails += ` (error: ${errorCodeMatch[1]})`;
}
if (vendorErrorMatch) {
    faultDetails += ` [vendor: ${vendorErrorMatch[1]}]`;
}

// Save to state
tracker.updateCharger(chargerId, { 
    status: 'Faulted',
    lastFaultReason: faultDetails
});
```

**Resultado no alerta:**
```
🔴 Carregador em FALHA

🔌 Carregador: GO2508130004

📝 Carregador entrou em estado FAULTED (OverCurrentFailure) [vendor: 02,40,120,0]
🕐 23:08
```

### 2. Alerta de Recuperação

Quando status muda de `Faulted` → `Available/Charging`:

```javascript
// RECOVERY DETECTION
if (oldStatus === 'Faulted' && (newStatus === 'Available' || newStatus === 'Charging')) {
    const faultReason = tracker.chargers[chargerId]?.lastFaultReason || 'Unknown fault';
    
    console.log(`✅ Charger ${chargerId} RECOVERED: ${oldStatus} → ${newStatus}`);
    
    queueAlert({
        type: 'charger_recovered',
        severity: 'info',
        chargerId,
        message: `Carregador recuperado: ${oldStatus} → ${newStatus}`,
        faultReason,  // ← Preserved from when it faulted
        timestamp: log.timestamp
    });
}
```

**Resultado no alerta:**
```
✅ Carregador RECUPERADO

🔌 Carregador: GO2508130004

📋 Problema anterior: Status: Faulted (error: OverCurrentFailure) [vendor: 02,40,120,0]

📝 Carregador recuperado: Faulted → Available
🕐 02:57

👍 Estação voltou ao normal
```

## Novos Campos no State

Cada carregador agora tem:

```json
{
  "id": "GO2508130004",
  "status": "Available",
  "lastFaultReason": "Status: Faulted (error: OverCurrentFailure) [vendor: 02,40,120,0]",
  "lastHeartbeat": "2026-02-12T05:57:00Z",
  ...
}
```

`lastFaultReason` é **preservado** quando o carregador se recupera, permitindo incluir essa informação no alerta de recovery.

## Benefícios

### Para Alertas de Falha
- ✅ **Contexto completo**: erro OCPP + código vendor
- ✅ **Diagnóstico rápido**: sabe imediatamente o tipo de problema
- ✅ **Menos suporte**: técnicos não precisam adivinhar

### Para Alertas de Recuperação
- ✅ **Visibilidade**: sempre notificado quando problema se resolve
- ✅ **Histórico**: sabe de qual problema se recuperou
- ✅ **Tranquilidade**: confirmação visual de que está tudo OK

## Logs de Debug

```
🔴 Charger GO2508130004 FAULTED: Status: Faulted (error: OverCurrentFailure) [vendor: 02,40,120,0]
✅ Charger GO2508130004 RECOVERED: Faulted → Available
```

## Testes

Script de simulação: `test-fault-recovery.js`

```
✅ Passo 1: Carregador FAULTED → salva detalhes do erro
✅ Passo 2: Carregador RECUPERADO → alerta com contexto
```

## Aplicação

```bash
pm2 restart ocpp-collector
pm2 restart ocpp-alerts
```

---

*Implementado: 2026-02-12 03:10 UTC*
*Issues: Falta de contexto em alertas + falta de notificação de recovery*
*Solicitado por: Thiago*

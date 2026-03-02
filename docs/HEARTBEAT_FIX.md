# Heartbeat Timeout com MeterValues - Fix v2

## Problema Atualizado

Além de não alertar durante transações ativas, também precisamos **verificar se estamos recebendo MeterValues** do carregador.

**MeterValues são sinais de vida**: Se o carregador está enviando MeterValues, significa que está ativo e comunicando, mesmo que o Heartbeat específico esteja atrasado/ausente.

## Solução v2

### 1. Tracking de MeterValues (`smart-collector.js`)

Agora rastreamos quando recebemos MeterValues de cada carregador:

```javascript
// Track MeterValues as sign of life (charger is active and communicating)
if (log.message.includes('MeterValues')) {
    const chargerId = extractChargerId(log);
    if (chargerId) {
        tracker.updateCharger(chargerId, { 
            lastMeterValue: log.timestamp,
            consecutiveErrors: 0  // Reset error count on activity
        });
        tracker.saveState();
    }
}
```

### 2. Lógica Aprimorada (`state-tracker.js`)

```javascript
// Condition 3: Heartbeat timeout > 5 min (check transaction AND MeterValues)
if (charger.lastHeartbeat) {
    const timeSinceHeartbeat = Date.now() - new Date(charger.lastHeartbeat).getTime();
    if (timeSinceHeartbeat > 5 * 60 * 1000) {
        
        // Check 1: Active transaction?
        if (charger.activeTransaction) {
            console.log(`⏸️ Transaction active - NOT flagging`);
            return;
        }
        
        // Check 2: Recent MeterValues?
        if (charger.lastMeterValue) {
            const timeSinceMeterValue = Date.now() - new Date(charger.lastMeterValue).getTime();
            if (timeSinceMeterValue < 5 * 60 * 1000) {
                console.log(`⏸️ Recent MeterValues (${time}s ago) - NOT flagging`);
                return;
            }
        }
        
        // If both checks fail: real problem
        charger.needsRestart = true;
    }
}
```

## Regras de Alerta

O sistema **SÓ alerta** para heartbeat timeout quando **TODAS** as condições são verdadeiras:

1. ✅ Heartbeat ausente por >5min
2. ✅ **NÃO** há transação ativa
3. ✅ **NÃO** há MeterValues recentes (<5min)

## Testes Validados

```
✅ Test 1: Timeout sem transação sem MeterValues → ALERTA
✅ Test 2: Timeout com transação ativa → NÃO alerta
✅ Test 3: Timeout mas MeterValues recentes → NÃO alerta
✅ Test 4: Timeout com MeterValues antigos → ALERTA
✅ Test 5: Heartbeat recente → NÃO alerta
```

## Campos do Charger State

Agora cada carregador rastreia:

```json
{
  "id": "GO2508130004",
  "status": "Charging",
  "lastHeartbeat": "2026-02-12T02:50:00Z",
  "lastMeterValue": "2026-02-12T02:52:00Z",   ← NOVO
  "lastEvent": "2026-02-12T02:52:30Z",
  "activeTransaction": "12345",
  "consecutiveErrors": 0,
  "needsRestart": false,
  "restartReason": ""
}
```

## Benefícios

- ✅ **Reduz falsos positivos** ainda mais
- ✅ **Reconhece sinais de vida** (MeterValues = carregador ativo)
- ✅ **Alertas precisos** - só quando realmente offline
- ✅ **Menos ruído** - menos notificações desnecessárias

## Aplicação

```bash
pm2 restart ocpp-collector
pm2 restart ocpp-alerts
```

---

*Implementado: 2026-02-12 02:54 UTC*
*Solicitado por: Thiago*

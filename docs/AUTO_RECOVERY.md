# Auto-Recovery: Limpeza Automática de Flags de Restart

## Problema

Sistema alertava sobre problemas **já resolvidos**:
- Carregador teve erro há 3 horas
- Sistema marcou `needsRestart = true`
- Carregador se recuperou (voltou a funcionar)
- **Mas o alerta continuava sendo enviado** (baseado em dados antigos)

### Exemplo Real (AR2510070008)

```
Alerta: "3 erros consecutivos" (23:35 - há 3h)

Logs atuais (02:50):
✅ Received Heartbeat (a cada 10s)
✅ StatusNotification: Available, NoError
✅ Funcionando perfeitamente
```

## Solução: Auto-Recovery

Adicionada função `checkChargerHealth()` que **limpa automaticamente** o flag `needsRestart` quando detecta sinais de recuperação.

### Lógica de Recuperação

```javascript
checkChargerHealth(chargerId) {
    // Se não está flagged, nada a fazer
    if (!charger.needsRestart) return;
    
    // SINAIS DE RECUPERAÇÃO:
    
    // 1. Heartbeat recente (<2min)
    if (lastHeartbeat < 2min ago) {
        ✅ RECUPERADO
        needsRestart = false
        consecutiveErrors = 0
    }
    
    // 2. MeterValues recentes (<2min)
    if (lastMeterValue < 2min ago) {
        ✅ RECUPERADO
        needsRestart = false
        consecutiveErrors = 0
    }
    
    // 3. Status saudável + sem erros
    if (status === Available/Charging && consecutiveErrors === 0) {
        ✅ RECUPERADO
        needsRestart = false
    }
}
```

### Quando Roda

A verificação roda **automaticamente** a cada `updateCharger()`:

```javascript
updateCharger(chargerId, updates) {
    // Apply updates
    Object.assign(charger, updates);
    
    // 1. Check if recovered (clear flag if yes)
    checkChargerHealth(chargerId);
    
    // 2. Check if needs restart (set flag if problem)
    checkRestartCondition(chargerId);
}
```

## Testes Validados

```
✅ Test 1: Charger flagged → receives heartbeat → RECOVERED
✅ Test 2: Charger flagged → receives MeterValues → RECOVERED
✅ Test 3: Charger Faulted → Available + no errors → RECOVERED
✅ Test 4: Charger still broken → REMAINS FLAGGED
```

### Simulação Real (AR2510070008)

```
Estado Antigo (3h atrás):
  needsRestart: true
  consecutiveErrors: 5
  status: Faulted

Heartbeat Recente (30s atrás):
  ✅ Charger AR2510070008 recovered: recent heartbeat
  needsRestart: false
  consecutiveErrors: 0
  status: Available
```

## Benefícios

- ✅ **Sem alertas duplicados** sobre problemas já resolvidos
- ✅ **Auto-limpeza** de flags antigos
- ✅ **Reduz ruído** - só alerta problemas atuais
- ✅ **Inteligente** - detecta múltiplos sinais de recuperação

## Logs de Debug

Quando um carregador se recupera, você verá:

```
✅ Charger GO2508130004 recovered: recent heartbeat
✅ Charger AR2510070008 recovered: healthy status (Available)
✅ Charger 124030001957 recovered: recent MeterValues
```

## Aplicação

```bash
pm2 restart ocpp-collector
pm2 restart ocpp-alerts
```

---

*Implementado: 2026-02-12 03:00 UTC*
*Issue: Alertas sobre problemas já resolvidos*
*Solicitado por: Thiago*

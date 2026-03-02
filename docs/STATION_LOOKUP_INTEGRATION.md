# Station Lookup Integration - Before & After

## Overview

Alertas OCPP agora incluem automaticamente o nome e localização da estação, tornando-os muito mais úteis e acionáveis.

## Implementation

**Modified:** `alert-processor.js`
- Import `lookupStation()` from `station-lookup.js`
- Enrich `formatAlertMessage()` to show station name + location when available
- Graceful fallback to charger ID only if station not found

## Examples

### Charger Needs Restart

**Before:**
```
🔴 *Carregador precisa de restart*

🔌 *Carregador: AR2510070008*

📝 3 erros consecutivos
🕐 23:42

♻️ Ação: Reiniciar via plataforma ou fisicamente
```

**After:**
```
🔴 *Carregador precisa de restart*

🏢 *VIVA - Samambaia Sul*
📍 Samambaia - DF
🆔 AR2510070008

📝 3 erros consecutivos
🕐 23:42

♻️ Ação: Reiniciar via plataforma ou fisicamente
```

---

### Charger Faulted

**Before:**
```
🔴 *Carregador em FALHA*

🔌 *Carregador: GO2508130004*

📝 Status: Faulted
🕐 23:42

⚡ Ação: Reiniciar remotamente via plataforma
```

**After:**
```
🔴 *Carregador em FALHA*

🏢 *Office 1524*
📍 Avenida T-14, Goiânia - GO
🆔 GO2508130004

📝 Status: Faulted
🕐 23:42

⚡ Ação: Reiniciar remotamente via plataforma
```

---

### Charger Recovered

**Before:**
```
✅ *Carregador RECUPERADO*

🔌 *Carregador: 124030001957*

📝 Carregador voltou ao status Available
🕐 23:42

👍 Estação voltou ao normal
```

**After:**
```
✅ *Carregador RECUPERADO*

🏢 *Metrópole Shopping 1*
📍 Avenida das Araucárias, Águas Claras - DF
🆔 124030001957

📝 Carregador voltou ao status Available
🕐 23:42

👍 Estação voltou ao normal
```

---

### Unknown Charger (Fallback)

When a charger ID is not in the stations map, it falls back to showing just the ID:

```
🔴 *Carregador precisa de restart*

🔌 *Carregador: UNKNOWN_ID_12345*

📝 Heartbeat timeout (>5min)
🕐 23:42

♻️ Ação: Reiniciar via plataforma ou fisicamente
```

## Benefits

✅ **Instant recognition** - Yuri/Alene know exactly WHERE the problem is  
✅ **No manual lookup** - Station name + location shown directly  
✅ **Better prioritization** - Public stations vs private, high-traffic vs low  
✅ **Graceful degradation** - Falls back to ID-only if station not in map  

## Testing

Run the test script to see all formats:

```bash
cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor
node test-station-alert.js
```

## Maintenance

The stations map auto-updates daily at 03:00 BRT via cron. To force an update:

```bash
node update-stations-map.js
```

After updating the map, restart the alert processor:

```bash
pm2 restart ocpp-alerts
```

## Next Steps

All future alertas will automatically use the enriched format. No code changes needed when adding new stations - they'll be picked up on the next daily update.

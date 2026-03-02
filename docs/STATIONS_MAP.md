# Mapeamento de Estações

## Overview

Sistema para manter um mapeamento atualizado entre IDs de carregadores e informações das estações (nome, endereço, etc).

## Arquivos

- **`update-stations-map.js`** - Script que consulta a API e atualiza o mapeamento
- **`station-lookup.js`** - Helper para consultar informações por ID
- **`history/stations-map.json`** - Mapeamento atual (atualizado diariamente)

## Uso

### Atualizar Mapeamento Manualmente

```bash
cd /home/openclaw/.openclaw/workspace/skills/turbo-station-monitor
node update-stations-map.js
```

### Consultar Informações de uma Estação

```javascript
const { lookupStation, formatAlert } = require('./station-lookup');

// Buscar dados da estação
const station = lookupStation('AR2510070008');
console.log(station);
// {
//   id: "AR2510070008",
//   name: "VIVA - Samambaia Sul",
//   location: "Samambaia - DF",
//   hours: "24 horas",
//   powerKw: 60,
//   description: null
// }

// Formatar alerta com informações da estação
const alert = formatAlert('AR2510070008', 'Heartbeat timeout (>5min)');
console.log(alert);
// 🚨 *VIVA - Samambaia Sul*
// 📍 Samambaia - DF
// 🆔 AR2510070008
// ⚠️ Heartbeat timeout (>5min)
```

### Verificar se Precisa Atualizar

```javascript
const { isStale } = require('./station-lookup');

if (isStale()) {
  console.log('Mapeamento desatualizado! Rode update-stations-map.js');
}
```

## Automação

**Cron Job Configurado:**
- **Frequência:** Diariamente às 03:00 BRT
- **Ação:** Atualiza `history/stations-map.json` com dados da API pública
- **ID do Job:** `6ce40ba7-32f6-4386-a7bc-e2131bba2fbe`

Para gerenciar o cron:
```bash
# Listar jobs
openclaw cron list

# Executar manualmente
openclaw cron run --job-id 6ce40ba7-32f6-4386-a7bc-e2131bba2fbe
```

## API Pública

**Endpoint:** `https://turbostation.com.br/api/public/stations`

**Resposta:**
```json
{
  "stations": [
    {
      "id": "AR2510070008",
      "name": "VIVA - Samambaia Sul",
      "location": "Samambaia - DF",
      "hours": "24 horas",
      "powerKw": 60,
      "imageUrl": "https://...",
      "description": null
    },
    ...
  ]
}
```

## Integração com Alertas

Use `formatAlert()` para incluir nome e localização da estação nos alertas OCPP:

```javascript
// Em vez de:
alert(`Carregador ${id} precisa de restart`);

// Use:
const { formatAlert } = require('./station-lookup');
alert(formatAlert(id, 'Precisa de restart'));
```

Isso transforma:
```
Carregador AR2510070008 precisa de restart
```

Em:
```
🚨 *VIVA - Samambaia Sul*
📍 Samambaia - DF
🆔 AR2510070008
⚠️ Precisa de restart
```

Muito mais útil! 🎯

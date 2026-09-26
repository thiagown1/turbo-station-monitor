---
titulo: Status dos conectores e falhas — o que cada coisa significa
publico: parceiro
---

# Status dos conectores e falhas — o que cada coisa significa

Cada tomada/conector da sua estação tem um status que aparece no painel. Veja o
que cada um quer dizer em português simples:

| Status | O que significa |
|---|---|
| Disponível (Available) | Livre, pronto para uma nova recarga |
| Preparando (Preparing) | Carro conectado, iniciando a sessão |
| Carregando (Charging) | Recarga em andamento |
| Suspenso — EV (SuspendedEV) | O carro pausou o carregamento (ex.: bateria cheia, limite do carro) |
| Suspenso — EVSE (SuspendedEVSE) | O próprio carregador pausou o fornecimento |
| Finalizando (Finishing) | Sessão terminando, ainda com o cabo conectado |
| Falha (Faulted) | O carregador reportou um erro nesse conector |
| Indisponível (Unavailable) | Conector bloqueado/fora de operação (não é falha ativa) |
| Offline | Sem comunicação com o sistema (ver o guia de estação offline) |

## Códigos de erro mais comuns

Quando um conector entra em falha, o carregador manda um "código de erro" técnico
(padrão OCPP). Os mais vistos na nossa frota, em português:

| Código | O que costuma significar |
|---|---|
| `OtherError` | Erro genérico reportado pelo carregador — não se encaixa nos outros códigos |
| `InternalError` | Erro interno do firmware do carregador |
| `GroundFailure` | Falha de aterramento — risco elétrico, precisa de atenção |
| `OverCurrentFailure` | Corrente elétrica excedeu o limite de segurança |
| `HighTemperature` | Temperatura alta no carregador (superaquecimento) |
| `OverVoltage` / `UnderVoltage` | Tensão elétrica fora da faixa normal (alta ou baixa) |
| `ConnectorLockFailure` | A trava do conector não travou/destravou corretamente |
| `EVCommunicationError` | Falha de comunicação entre carregador e veículo |
| `PowerMeterFailure` | Falha no medidor de energia |
| `PowerSwitchFailure` | Falha na chave/relé de potência |
| `ReaderFailure` | Falha no leitor (RFID/cartão) |
| `WeakSignal` | Sinal de rede fraco no carregador |
| `NoError` | Não é um erro — indica que está tudo normal |

Casos específicos já vistos na frota: **conector mal encaixado** (cabo não
encaixado até travar — reencaixe, não é falha grave); **botão de emergência
pressionado** (precisa ser destravado fisicamente no local); **porta do
gabinete aberta**, em alguns modelos (verifique e feche).

## O alerta "Carregador em falha"

Quando um carregador seu entra em falha, você pode receber uma mensagem
automática no formato:

```
⚠️ Carregador em falha
🆔 <id do carregador> — conector <N>
<descrição da falha>
Código: <código>
Info: <detalhe>

Verifique o status atual no painel.
```

Esse alerta é enviado uma vez por carregador/tipo de falha a cada 2 horas — ele
não fica repetindo a cada minuto enquanto a falha continuar ativa. Ele significa
que o time interno já foi avisado também; o alerta para você é para que possa
checar o equipamento no local (porta do gabinete, botão de emergência, conector
mal encaixado) enquanto o time acompanha pelo painel.

## O que fazer ao receber o alerta

1. Confira o painel para ver o status atual — a falha pode já ter se resolvido
   sozinha.
2. Se for algo físico e simples (cabo mal encaixado, botão de emergência,
   porta do gabinete), resolva no local.
3. Se a falha persistir ou for um código elétrico mais sério (aterramento,
   sobrecorrente, sobretensão/subtensão), não tente mexer no equipamento —
   avise o time.

Fontes:
- next/app/dashboard/components/station-status-banner.tsx
- next/app/dashboard/components/station-health-panel.tsx
- next/app/api/webhook/status-notification/types.ts
- next/app/api/internal/partner-fault-alert/route.ts
- docs/internal/architecture/vps-monitor.md (seção "Partner fault notifier")

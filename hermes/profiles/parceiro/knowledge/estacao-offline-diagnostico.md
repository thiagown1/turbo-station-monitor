---
titulo: Minha estação está "offline" — o que fazer
publico: parceiro
---

# Minha estação está "offline" — o que fazer

## O que "offline" significa

"Offline" (ou "Sem comunicação") quer dizer que o carregador **parou de falar com o
nosso sistema** pela internet — não é o mesmo que "sem energia" nem "com defeito".
O sistema considera a estação viva quando recebe sinais periódicos do carregador
(heartbeat) ou quando algum conector está em uma sessão ativa (Preparando,
Carregando, etc.). Se não chega nenhum sinal por um tempo e nenhum conector está
em uso, a estação some do mapa como offline.

Quando o carregador realmente cai da nossa rede, o próprio servidor marca a
estação e todos os conectores como "Offline" em poucos segundos — então esse
status reflete uma queda real de conexão, não uma demora de atualização de tela.

## Causas mais comuns

- **Internet do local caiu** — Wi-Fi ou chip 4G do carregador sem sinal, roteador
  reiniciando, operadora com instabilidade.
- **Falta de energia no ponto** — disjuntor desarmado, queda de energia no
  condomínio/prédio, obra elétrica local.
- **Instabilidade momentânea de rede** — o carregador reconecta sozinho depois de
  alguns instantes; nesse caso não é preciso fazer nada.
- **Problema no próprio equipamento** — reinício travado, falha de hardware.

## O que você pode checar no local

1. **Luz/indicador do carregador** — veja se o equipamento está ligado (luz de
   status acesa) ou completamente apagado.
2. **Disjuntor do carregador** — confira se não desarmou. Se desarmou, religue e
   aguarde alguns minutos para o equipamento reconectar.
3. **Sinal de internet/4G** — se o carregador usa um chip próprio, verifique se há
   sinal no local (antena, chip inserido corretamente); se usa Wi-Fi, confirme se o
   roteador está ligado e respondendo.
4. **Tela/display do carregador** (quando o modelo tiver) — alguma mensagem de erro
   visível ajuda o time a diagnosticar mais rápido.

## Reinício manual

PENDENTE: confirmar se existe um procedimento documentado e seguro de
desligar/religar o carregador manualmente (por exemplo, pelo disjuntor) que o
parceiro possa fazer sozinho, e em quais modelos isso é recomendado. Hoje não
encontrei nos documentos um passo a passo de reset físico para o parceiro seguir;
o reinício remoto pelo sistema (comando de reset) é feito pelo time da Turbo
Station pelo painel, não pelo parceiro.

## Quando chamar o time

- O carregador ficou offline por mais de alguns minutos e você já conferiu
  disjuntor e internet no local.
- A luz do equipamento está apagada mesmo com o disjuntor ligado.
- Você recebeu um alerta nosso avisando que a estação está sem comunicação.

Nesses casos, chame o time da Turbo Station informando o nome/local da estação e
o que você já verificou no site — isso agiliza o diagnóstico. Se for algo que o
sistema já sabe resolver sozinho (reconexão automática), normalmente a estação
volta sem qualquer ação de ninguém.

Fontes:
- next/app/dashboard/components/station-health-utils.ts
- docs/internal/architecture/alert-station-offline.md
- docs/internal/architecture/ocpp-server.md
- docs/internal/architecture/vps-monitor.md (seção "Partner fault notifier", cenário `station_offline`)

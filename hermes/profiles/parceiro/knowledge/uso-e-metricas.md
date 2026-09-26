---
titulo: Sessões, kWh e métricas — o que os números significam
publico: parceiro
---

# Sessões, kWh e métricas — o que os números significam

## O que cada número representa

- **Sessão/recarga** — um ciclo completo de carregamento, do início ao fim.
- **kWh** — a energia entregue durante as sessões (base da sua receita por
  kWh).
- **Horas de carregamento** — soma do tempo em que os conectores ficaram em
  status "Carregando".
- **Sessões com falha / tentativas** — quando alguém tenta iniciar uma recarga
  e ela não completa (rejeitada, carregador ocupado, falha do equipamento,
  etc.). O painel de cada estação mostra essas tentativas, o que ajuda a
  perceber problemas recorrentes num carregador específico.

No painel, os totais aparecem em três janelas: **Hoje**, **últimos 7 dias** e
**mês**.

## Como o fechamento do dia funciona (fuso horário)

Os totais diários fecham no **dia UTC** em que a sessão terminou, não no
horário de Brasília. Como o Brasil está atrás do UTC, uma sessão que termina
tarde da noite (por volta das 21h–24h no horário de Brasília) pode aparecer
contabilizada no dia seguinte. Isso é esperado — não é um erro de contagem, é
só o fuso horário do fechamento.

## Pequenos atrasos e ajustes são normais

O número que você vê no relatório (e no repasse) vem de um resumo diário
pré-calculado, não recalculado em tempo real a cada consulta. Isso significa
que, em situações raras (uma reinicialização do sistema no meio de uma sessão,
por exemplo), pode haver um pequeno atraso até um valor aparecer contabilizado.
Existem verificações automáticas rodando todas as noites para conferir e
corrigir esses casos — pequenas diferenças de centavos entre o valor bruto e o
resumo são toleradas e consideradas normais; diferenças maiores são investigadas
pelo time.

## Se um número parecer errado

Antes de reportar, dê um tempo — números do dia corrente ainda podem se ajustar
enquanto o dia UTC não fecha. Se depois de fechado o total ainda parecer
incorreto (muito diferente do esperado, não só um pequeno ajuste de centavos),
avise o time com a estação e o período específico — isso é investigado com os
dados brutos das transações, não só o resumo.

Fontes:
- docs/internal/architecture/partner-overview.md (nota sobre datas em UTC)
- docs/internal/architecture/partner-report-service.md (seção "Summary reconciliation")
- docs/internal/architecture/next-app.md (janelas Hoje / 7 dias / mês)
- next/app/dashboard/settings/stations/components/start-attempts-tab.tsx

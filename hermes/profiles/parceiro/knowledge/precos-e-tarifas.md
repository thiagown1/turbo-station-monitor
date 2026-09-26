---
titulo: Preços e tarifas — como funcionam e como alterar
publico: parceiro
---

# Preços e tarifas — como funcionam e como alterar

## Como o preço da sua estação funciona

Cada estação tem um preço base por kWh (o valor cobrado do motorista por kWh
consumido). Esse preço pode ser configurado de três formas no painel:

- **Fixo** — um único valor de R$/kWh o tempo todo.
- **Agenda (horário)** — uma grade de preço por hora do dia (por exemplo, preço
  diferente de dia e de madrugada). É possível configurar de forma simples
  (preço "dia" e "noite") ou avançada (24 horas independentes).
- **Automático** — o preço segue uma fonte de precificação de mercado
  (dinâmico), quando essa opção está habilitada para a estação.

O preço realmente cobrado no momento da recarga pode ainda ser reduzido por um
cupom válido aplicado pelo motorista.

## Como alterar o preço

O preço é editado no painel, na aba **Cobrança** da edição da estação (ou na aba
de Operação, no cartão de preço). Só quem tem acesso de administrador àquela
estação (ou uma delegação específica de preço, quando combinada com o time)
consegue alterar. Também é possível pedir a mudança ao time, ou usar o
assistente de IA do painel (não o WhatsApp) para propor a alteração — nesse
caso, você sempre confirma o valor antes de ele ser salvo.

Não existe piso ou teto fixo aplicado a todo mundo — os limites, quando
existem, são combinados individualmente para quem tem apenas uma delegação de
preço (sem ser dono da estação).

## Taxa de ociosidade e outras tarifas configuráveis

Além do preço por kWh, existem outras configurações por estação, como:
- **taxa de ociosidade** (cobrada do motorista que deixa o carro conectado
  depois que a recarga terminou);
- precificação dinâmica;
- deduções do repasse;
- reembolso de energia.

Hoje a maior parte dessas configurações é feita pelo time (admin da marca) a seu
pedido — o painel já mostra um checklist ("Configure sua operação") indicando
quais itens estão configurados, disponíveis ou pendentes para a sua estação;
os itens que ainda não são de autoatendimento aparecem com a orientação "peça
pro admin da marca".

## Cupons de desconto

Você pode criar seus próprios cupons de desconto para as suas estações
diretamente na aba **Cupons** do painel ("Novo cupom"), sem precisar de
aprovação do time:
- o cupom pode valer para todas as suas estações ou só para algumas;
- pode ser restrito a usuários específicos (por e-mail);
- você só vê e gerencia os cupons que você mesmo criou.

Cupons com uso ilimitado e sem restrição de grupo de usuários têm risco de abuso
— evite deixá-los assim; se possível, limite o uso ou restrinja a um grupo.

PENDENTE: confirmar se existe algum piso/teto de preço por kWh aplicado
automaticamente a todas as estações (o que encontrei documenta apenas limites
para delegações específicas de preço, não uma regra geral de piso/teto por
contrato).

Fontes:
- docs/internal/architecture/pricing-schedule-writers.md
- docs/internal/architecture/partner-finance.md
- docs/internal/architecture/partner-self-create.md
- docs/internal/changelog/2026-07-31-pr-1586-partner-setup-checklist-discovery.md
- docs/internal/architecture/alert-idle-too-long.md

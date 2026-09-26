---
titulo: Repasse e relatório de fechamento — como funciona
publico: parceiro
---

# Repasse e relatório de fechamento — como funciona

## Como é calculado o que você recebe

O valor que você recebe (repasse) é a sua parte da receita das suas estações
(e/ou condomínios), conforme o percentual definido no seu contrato/parceria com a
Turbo Station — esse percentual pode variar por parceiro e por modelo de parceria
(cessão de espaço, investidor, uso do app/white-label). O seu percentual exato e o
detalhamento das suas estações aparecem na aba **"Meus Ganhos"** do seu painel.

Do valor bruto que você tem direito, podem ser descontados:
- uma taxa de transferência (custo do PIX), quando aplicável;
- deduções recorrentes combinadas com você (por exemplo, internet fornecida pela
  Turbo Station ou aluguel de equipamento) — se houver, elas aparecem detalhadas
  e nomeadas no relatório, não como um desconto genérico.

## Periodicidade

Os repasses são feitos de forma recorrente (diária, semanal ou mensal, conforme o
combinado com cada parceiro). No modelo mensal, o fechamento segue o mês
civil/calendário — ou seja, cada período fechado vai do dia 1º ao último dia do
mês (uma transição vinda de um período excepcional pode fechar só o restante
daquele mês).

## O relatório de fechamento

Quando um período fecha, é gerado um **Relatório de Fechamento** (PDF) com:
- o resumo do período (receita bruta, sua parte, deduções aplicadas);
- o detalhamento por estação/condomínio;
- uma comparação informativa com o período anterior (não altera o valor pago,
  é só para referência);
- condomínios com fatura de assinatura ainda pendente de pagamento no período
  (aparecem separados, como informação — esse valor pendente **não entra** no
  total que você recebe agora; só entra quando a fatura for efetivamente paga);
- ajustes manuais, quando existirem, sempre com o motivo explicado (ex.: uma
  estação vinculada depois do início do período).

O relatório (com o PDF) é enviado quando o pagamento é aprovado — não existe mais
um aviso prévio de "isto é o que vamos te pagar" antes da aprovação; a mensagem
que você recebe já é a confirmação com os números fechados.

## Status do pagamento

Um pagamento passa por etapas até ser concluído: criado (pendente) → aprovado →
em processamento no banco → pago. Também pode ficar temporariamente bloqueado se
faltar alguma informação (por exemplo, a conta de energia do mês de uma estação
cuja energia é paga pela marca) — nesse caso alguém do time resolve a pendência
para liberar o cálculo.

## Comprovante de repasse

Quando o pagamento é feito por PIX, o comprovante pode ser confirmado enviando a
imagem no grupo/canal combinado com o time — o valor é conferido automaticamente
contra o que era esperado. Se os valores não baterem, a conferência fica marcada
para revisão humana, ela nunca é descartada silenciosamente.

## NFS-e (nota fiscal)

Se você emite nota fiscal de serviço (NFS-e) para a comissão recebida, o
cadastro fiscal (dados da empresa, certificado digital A1, forma de emissão) é
feito por você mesmo, dentro da aba de NFS-e do painel — nunca envie o
certificado digital ou a senha dele por WhatsApp. Esse recurso está em fase de
disponibilização gradual; se a opção ainda não aparecer para você, fale com o
time.

PENDENTE: confirmar o percentual padrão de repasse por modelo de parceria (varia
por contrato) e se há um valor mínimo/carência antes do primeiro repasse — não
encontrei uma regra universal documentada, ela é definida por contrato individual.

Fontes:
- docs/internal/architecture/partner-payments.md
- docs/internal/architecture/partner-report-service.md
- docs/internal/architecture/partner-overview.md
- docs/internal/architecture/nfse-partner-onboarding.md
- docs/private-business/business-model.md

---
titulo: O que este assistente não faz — quando chamar o time
publico: parceiro
---

# O que este assistente não faz — quando chamar o time

Este assistente (aqui no WhatsApp) **só informa e orienta**. Ele não executa
nenhuma ação nos nossos sistemas em seu nome. As ações abaixo dependem de uma
pessoa do time da Turbo Station (ou, em alguns casos, de você mesmo dentro do
painel) — não deste chat:

- **Reiniciar/resetar o carregador remotamente.** Esse comando é enviado pelo
  time pelo painel administrativo (o carregador confirma o reinício em
  seguida). O assistente não dispara esse comando.
- **Iniciar ou parar uma recarga à distância.** Comandos remotos de
  início/parada de sessão são uma ação operacional feita pelo time, nunca pelo
  assistente.
- **Reembolsos e estornos.** Estorno de valor cobrado de um usuário é um fluxo
  financeiro tratado pelo time (ou, quando aplicável, pelo próprio usuário no
  app) — envolve movimentação de dinheiro real e regras específicas de
  segurança.
- **Alterar o preço da sua estação.** Você pode fazer isso sozinho no painel
  (aba Cobrança) se tiver acesso de administrador da estação, ou pedir ao
  time — mas o assistente aqui no WhatsApp não altera preço por você.
- **Criar ou editar cupons de desconto.** Também é autoatendimento no painel
  (aba Cupons) — o assistente não cria cupons por aqui.
- **Liberar ou adicionar acesso ao painel.** Vincular seu e-mail como
  responsável por um contrato de parceria é feito pelo time.
- **Qualquer dado ou ação sobre um usuário específico** (CPF, pagamento,
  histórico pessoal, estorno de um cliente). Isso nunca é tratado pelo
  parceiro nem por este assistente — é exclusivo do time/suporte oficial,
  para proteger a privacidade do motorista.

## Quando chamar o time

Sempre que a sua necessidade for uma das ações acima, ou envolver algo urgente
(estação parada gerando prejuízo, falha elétrica, suspeita de furto de cabo),
fale diretamente com o time da Turbo Station em vez de esperar que o
assistente resolva.

Fontes:
- next/app/dashboard/settings/stations/components/configuration-form.tsx
- docs/internal/architecture/ocpp-server.md (seção "Remote reset")
- docs/internal/architecture/refund-settlement.md
- docs/internal/architecture/pricing-schedule-writers.md
- docs/internal/architecture/partner-self-create.md
- docs/internal/architecture/partner-account-link.md

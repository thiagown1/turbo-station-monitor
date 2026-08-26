# Contador — aprovação pessoal de classificação financeira

## Escopo

Este fluxo transforma uma detecção de `expense_receipt` em uma proposta
financeira enviada somente ao WhatsApp pessoal configurado do operador. A
proposta contém o resumo do comprovante e uma única ação imutável:
`classify_expense` com uma categoria permitida.

A confirmação grava apenas um marcador em
`contador_financial_classifications`. Ela **não**:

- movimenta saldo;
- registra pagamento de empréstimo;
- cria custo em `accounting_monthly_costs`;
- cria crédito, estorno ou pagamento;
- chama `/api/agents/events`, `/api/agents/expense-decisions` ou qualquer rota
  financeira do Next;
- envia mensagem ao grupo original ou a terceiros.

Essa fronteira é intencional. O endpoint atual de despesas do Next depende de
um prompt citado dentro da conversa contábil e pode enviar uma nova mensagem ao
grupo. A aprovação pessoal não contorna esse gate. Publicar a classificação no
Agent Center ou transformar uma classificação de `emprestimos` em
`LoanPayment` exige outro contrato explícito, testes no repositório do Next e
uma autorização separada.

## Ativação fail-closed

O deploy do código não ativa o fluxo. Todas as condições abaixo precisam ser
verdadeiras:

| Variável | Regra |
|---|---|
| `CONTADOR_FINANCIAL_APPROVAL_ENABLED` | `true`; padrão `false` |
| `CONTADOR_FINANCIAL_APPROVAL_OPERATOR_JID` | número/JID pessoal; JID de grupo (`@g.us`) é recusado |
| `CONTADOR_FINANCIAL_APPROVAL_ALLOWED_SENDER_IDS` | allowlist de números, somente dígitos |
| `CONTADOR_FINANCIAL_APPROVAL_TTL_MINUTES` | 5 a 60 minutos; padrão 15 |

O número extraído do alvo também precisa estar na allowlist. Configuração
incompleta deixa a proposta em `waiting_config`, sem envio e sem fallback para
o fluxo central. Categoria ausente ou fora de `gateway`, `ia`, `infra`,
`marketing`, `taxas`, `emprestimos` e `outros` fica
`blocked_invalid_action`.

## Protocolo do operador

A mensagem pessoal mostra o código `FIN-XXXXXXXX`, o resumo, favorecido, valor,
categoria e expiração. A confirmação só é aceita quando:

1. o remetente está na allowlist;
2. a mensagem cita o `outbound_message_id` exato da proposta;
3. o texto é exatamente `APROVAR FIN-XXXXXXXX` ou
   `RECUSAR FIN-XXXXXXXX`;
4. a proposta ainda está em `awaiting_confirmation` e não expirou;
5. o hash do payload imutável confere antes da escrita.

Respostas livres, código inexistente, citação errada, remetente não autorizado,
duplicidade, expiração e proposta encerrada não executam nada. Remetente não
autorizado recebe silêncio para evitar conversa com terceiros.

## Persistência e recuperação

`contador_financial_proposals` é simultaneamente ledger e fila durável:

- envio: `pending_send` → `sending` → `awaiting_confirmation`;
- confirmação: `awaiting_confirmation` → `confirmed` ou `rejected`;
- execução: `confirmed` → `executing` → `executed`;
- falhas definitivas/ambíguas: `failed_delivery`, `delivery_unknown`,
  `failed_execution`;
- retries limitados: `retry_send` e `execution_retry` com orçamentos separados;
- configuração incompleta: `waiting_config`;
- TTL: `expired`.

Uma interrupção durante o envio vira `delivery_unknown` e não é reenviada
automaticamente. Uma interrupção durante a escrita local volta para
`execution_retry`, porque a chave primária `source_message_id` e o
`payload_hash` tornam a repetição segura. O marcador final em
`contador_financial_classifications` é único por comprovante e por proposta.

O fluxo só cria propostas dentro da mesma transação que persiste uma nova
análise de mídia. Um resultado antigo já presente em `agent_media_analyses`
retorna como duplicado e não cria proposta; portanto ativar a flag não
reprocessa comprovantes históricos.

## Auditoria

As ações são registradas em `audit_log` sem corpo do comprovante, código de
confirmação, chave ou token:

- `contador_financial_proposal_created`;
- `contador_financial_proposal_sent` / `..._send_failed`;
- `contador_financial_confirmation_rejected`;
- `contador_financial_proposal_confirmed` / `..._rejected` / `..._expired`;
- `contador_financial_execution_started`;
- `contador_financial_execution_completed` / `..._failed`.

O texto completo existe somente na conversa pessoal já persistida em
`messages`, como ocorre com outras mensagens do WhatsApp.

## Inspeção operacional somente leitura

Antes e depois de qualquer futura ativação, confira:

```sql
SELECT status, COUNT(*)
FROM contador_financial_proposals
GROUP BY status;

SELECT source_message_id, proposal_id, action_type, classified_at
FROM contador_financial_classifications
ORDER BY classified_at DESC
LIMIT 20;

SELECT action, created_at
FROM audit_log
WHERE action LIKE 'contador_financial_%'
ORDER BY created_at DESC
LIMIT 50;
```

Não imprima `action_payload_json` ou o corpo da conversa em logs operacionais.

## Gate futuro de produção

Uma ativação posterior precisa de autorização específica para a configuração e
o ambiente exatos. Sequência recomendada:

1. revisar diff, testes e rollback;
2. fazer backup consistente do SQLite;
3. publicar o código ainda com a flag `false`;
4. validar saúde, schema e ausência de propostas novas;
5. configurar um único alvo pessoal e a allowlist correspondente;
6. obter autorização separada para mudar somente a flag e reiniciar apenas
   `support-copilot`;
7. testar com um comprovante novo e controlado, nunca com backlog histórico;
8. rollback: flag `false`, reinício de `support-copilot` e inspeção das filas.

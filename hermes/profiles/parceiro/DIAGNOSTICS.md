# Diagnóstico operacional pelo WhatsApp

O Next autoriza cada estação e projeta detalhes operacionais dos bicos; o modelo
não amplia o acesso. Estado atual, códigos, horários, recargas ativas, comandos
de disponibilidade e tentativas de início devem ser conservados na resposta.
Notificações não são incidentes independentes, NoError não comprova ausência de
problema físico e códigos proprietários ficam sem interpretação confirmada.

O monitor aceita `replyContract.sections` para compor até cinco estações. Cada
seção contém stationId e texto; repetição idêntica é deduplicada e conflito da
mesma estação, mistura com legado ou composição acima de 8.000 caracteres é
bloqueada. Contratos antigos sem sections permanecem válidos isoladamente.
O Next deve aceitar esse mesmo limite em `propose_reply` antes da ativação.
As permissões, a allowlist, a menção estruturada e a configuração de autoSend
continuam sendo definidas pelo servidor.

`parceiro_esclarecer` seleciona uma pergunta fixa de `clarifications.json`,
compartilhado pelo plugin e pelo monitor. Permite pedir estação/bico, referência
ao erro anterior, o indicador que está alternando ou transcrição de áudio.
Só erros de seleção de estação podem ser acompanhados dessa pergunta; falhas de
acesso/provedor/evidência continuam bloqueadas. Não aceita texto livre do modelo.

Áudio permanece uma lacuna: o claim atual recebe `[🎤 Áudio]`, sem transcrição.
A resposta deve pedir texto, nunca afirmar que ouviu. Não reutilizar o Whisper
legado sem corrigir suas proteções de mídia, política, custo e logs. A validação
de uma pergunta já transcrita não certifica o recebimento de áudio pelo WhatsApp.

Verificação local: testes Node do runtime/simulador e unittest do plugin/prompt.
Ensaios de modelo devem usar perfil temporário e API em loopback, sem rotas de
escrita, envio ao grupo, alteração de credenciais ou ativação em produção.

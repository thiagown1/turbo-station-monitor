#!/bin/bash
# Manual Alert Test - Send test alert to WhatsApp

echo "🧪 OCPP Alert Test"
echo "=================="
echo ""
echo "This will send a TEST alert to the WhatsApp support group."
echo "Group: 120363423472541295@g.us"
echo ""

read -p "Which test? (1=Faulted, 2=Recovery, 3=User Failed, 4=Custom): " choice

case $choice in
    1)
        MESSAGE="🔴 *[TEST] Carregador em FALHA*

🔌 *Carregador: TEST-999*

❌ Erro: \`OverCurrentFailure\`
🔧 Vendor: \`9,9,9,9\`
🔌 Conector: 1

📝 Teste de alerta - StatusNotification: Faulted

🕐 $(date '+%H:%M')

⚡ Ação: Reiniciar remotamente via plataforma

⚠️ ESTE É UM TESTE DO SISTEMA DE ALERTAS"
        ;;
    2)
        MESSAGE="✅ *[TEST] Carregador RECUPERADO*

🔌 *Carregador: TEST-999*

📝 Teste de alerta - Carregador recuperado: Faulted → Available

🕐 $(date '+%H:%M')

👍 Estação voltou ao normal

⚠️ ESTE É UM TESTE DO SISTEMA DE ALERTAS"
        ;;
    3)
        MESSAGE="🟡 *[TEST] Usuário não conseguiu iniciar carga*

🔌 *Carregador: TEST-999*

❌ Erro: \`InvalidToken\`
🔌 Conector: 2

📝 Teste de alerta - StartTransaction rejected

🕐 $(date '+%H:%M')

👤 Ação: Verificar logs do app/autorização

⚠️ ESTE É UM TESTE DO SISTEMA DE ALERTAS"
        ;;
    4)
        read -p "Enter custom message: " CUSTOM_MSG
        MESSAGE="🧪 *[TEST] Alerta Customizado*

📝 $CUSTOM_MSG

🕐 $(date '+%H:%M')

⚠️ ESTE É UM TESTE DO SISTEMA DE ALERTAS"
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "Sending:"
echo "--------"
echo "$MESSAGE"
echo ""

# Send via OpenClaw
ESCAPED_MSG=$(echo "$MESSAGE" | sed "s/'/'\\\\''/g")
openclaw message send --channel whatsapp --target '120363423472541295@g.us' --message "$ESCAPED_MSG"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Test alert sent successfully!"
    echo ""
    echo "Check WhatsApp group to verify delivery."
else
    echo ""
    echo "❌ Failed to send test alert"
fi

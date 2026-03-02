// Patch for formatAlertMessage to add faultReason support

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'alert-processor.js');
let content = fs.readFileSync(file, 'utf8');

// Add faultReason to destructuring
content = content.replace(
    'const { chargerId, message, timestamp, rawLog } = alert;',
    'const { chargerId, message, timestamp, rawLog, faultReason } = alert;'
);

// Add recovery reason display after charger ID
const recoveryInsert = `
    // For recovery alerts: show what it recovered FROM
    if (alert.type === 'charger_recovered' && faultReason) {
        msg += \`📋 Problema anterior: \${faultReason}\\\\n\\\\n\`;
    }
`;

content = content.replace(
    '    // Extract detailed error info from message',
    recoveryInsert + '    // Extract detailed error info from message'
);

fs.writeFileSync(file, content);
console.log('✅ Patch applied to alert-processor.js');

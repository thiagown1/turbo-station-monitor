const fs = require('fs');
const code = fs.readFileSync('smart-collector.js', 'utf8');

const lines = code.split('\n');
let result = [];
let inBlock = false;
let blockStart = -1;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("if (msg.includes('Faulted')) {")) {
        inBlock = true;
        blockStart = i;
        // Insert new code
        result.push(lines[i]); // if (msg.includes('Faulted')) {
        result.push('            // Extract error details');
        result.push('            const errorCodeMatch = msg.match(/error_code[=:]?\\s*([A-Za-z]+)/);');
        result.push("            const infoMatch = msg.match(/['\\\"']info['\\\"']:\\s*['\\\"']([^'\\\"']+)['\\\"']/);");
        result.push("            const vendorErrorMatch = msg.match(/vendor_error_code[=:]?\\s*['\\\"']([^'\\\"']+)['\\\"']/);");
        result.push('            ');
        result.push("            let alertMsg = 'Carregador entrou em estado FAULTED';");
        result.push('            ');
        result.push('            // Priority: info field (most specific) > error_code (generic)');
        result.push('            if (infoMatch) {');
        result.push('                alertMsg += `: ${infoMatch[1]}`;');
        result.push('            }');
        result.push('            if (errorCodeMatch) {');
        result.push('                alertMsg += ` (${errorCodeMatch[1]})`;');
        result.push('            }');
        result.push('            if (vendorErrorMatch) {');
        result.push('                alertMsg += ` [vendor: ${vendorErrorMatch[1]}]`;');
        result.push('            }');
        result.push('            ');
        result.push('            return { ');
        result.push('                important: true, ');
        result.push('                category: \\'charger_faulted\\', ');
        result.push('                severity: \\'critical\\',');
        result.push('                alert: true,');
        result.push('                alertMessage: alertMsg,');
        result.push('                metadata: {');
        result.push('                    errorCode: errorCodeMatch ? errorCodeMatch[1] : null,');
        result.push('                    info: infoMatch ? infoMatch[1] : null,');
        result.push('                    vendorErrorCode: vendorErrorMatch ? vendorErrorMatch[1] : null');
        result.push('                }');
        result.push('            };');
        continue;
    }
    
    if (inBlock) {
        // Skip old block until we hit the closing };
        if (lines[i].trim() === '};') {
            inBlock = false;
        }
        continue;
    }
    
    result.push(lines[i]);
}

fs.writeFileSync('smart-collector.js', result.join('\n'));
console.log('✅ Fixed info field extraction');

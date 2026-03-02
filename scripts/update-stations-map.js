#!/usr/bin/env node
/**
 * update-stations-map.js
 * 
 * Consulta a API pública de estações e atualiza o mapeamento
 * ID → nome, localização, detalhes
 * 
 * Uso:
 *   node update-stations-map.js
 * 
 * Atualiza: ./history/stations-map.json
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://turbostation.com.br/api/public/stations';
const OUTPUT_FILE = path.join(__dirname, 'history', 'stations-map.json');

function fetchStations() {
  try {
    // Usar curl com -L para seguir redirects
    const response = execSync(`curl -sL ${API_URL}`, { encoding: 'utf-8' });
    return JSON.parse(response);
  } catch (error) {
    throw new Error(`Falha ao consultar API: ${error.message}`);
  }
}

async function main() {
  console.log('🔄 Atualizando mapeamento de estações...');
  
  try {
    const data = fetchStations();
    
    if (!data.stations || !Array.isArray(data.stations)) {
      throw new Error('Formato inválido de resposta da API');
    }

    // Criar mapeamento ID -> dados da estação
    const stationsMap = {};
    data.stations.forEach(station => {
      stationsMap[station.id] = {
        id: station.id,
        name: station.name,
        location: station.location,
        hours: station.hours,
        powerKw: station.powerKw,
        description: station.description || null
      };
    });

    // Salvar arquivo
    const output = {
      updatedAt: new Date().toISOString(),
      count: data.stations.length,
      stations: stationsMap
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
    
    console.log(`✅ Mapeamento atualizado: ${data.stations.length} estações`);
    console.log(`📁 Salvo em: ${OUTPUT_FILE}`);
    
    // Mostrar alguns exemplos
    const examples = data.stations.slice(0, 3);
    console.log('\n📍 Exemplos:');
    examples.forEach(s => {
      console.log(`  - ${s.id}: ${s.name} (${s.location})`);
    });

  } catch (error) {
    console.error('❌ Erro ao atualizar estações:', error.message);
    process.exit(1);
  }
}

main();

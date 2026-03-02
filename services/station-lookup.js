/**
 * station-lookup.js
 * 
 * Helper para consultar informações de estações pelo ID do carregador
 */

const fs = require('fs');
const path = require('path');

const STATIONS_MAP_FILE = path.join(__dirname, '..', 'history', 'stations-map.json');

/**
 * Busca informações de uma estação pelo ID
 * @param {string} chargerId - ID do carregador (ex: "AR2510070008")
 * @returns {object|null} - Dados da estação ou null se não encontrado
 */
function lookupStation(chargerId) {
  try {
    if (!fs.existsSync(STATIONS_MAP_FILE)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(STATIONS_MAP_FILE, 'utf-8'));
    
    if (!data.stations || !data.stations[chargerId]) {
      return null;
    }

    return data.stations[chargerId];
  } catch (error) {
    console.error('Erro ao buscar estação:', error.message);
    return null;
  }
}

/**
 * Formata uma mensagem de alerta com informações da estação
 * @param {string} chargerId - ID do carregador
 * @param {string} issue - Descrição do problema
 * @returns {string} - Mensagem formatada
 */
function formatAlert(chargerId, issue) {
  const station = lookupStation(chargerId);
  
  if (station) {
    return `🚨 *${station.name}*\n📍 ${station.location}\n🆔 ${chargerId}\n⚠️ ${issue}`;
  } else {
    return `🚨 *Carregador ${chargerId}*\n⚠️ ${issue}`;
  }
}

/**
 * Verifica se o mapeamento está desatualizado (>48h)
 * @returns {boolean} - true se precisa atualizar
 */
function isStale() {
  try {
    if (!fs.existsSync(STATIONS_MAP_FILE)) {
      return true;
    }

    const data = JSON.parse(fs.readFileSync(STATIONS_MAP_FILE, 'utf-8'));
    const updatedAt = new Date(data.updatedAt);
    const hoursSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
    
    return hoursSinceUpdate > 48;
  } catch (error) {
    return true;
  }
}

module.exports = {
  lookupStation,
  formatAlert,
  isStale
};

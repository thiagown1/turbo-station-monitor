/**
 * station-lookup.js
 * 
 * Helper para consultar informações de estações pelo ID do carregador
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const STATIONS_MAP_FILE = path.join(__dirname, '..', 'history', 'stations-map.json');
const UPDATER_SCRIPT = path.join(__dirname, '..', 'scripts', 'update-stations-map.js');

// In-process throttle so a burst of lookups triggers at most one refresh per hour.
let lastRefreshAttemptMs = 0;
const REFRESH_THROTTLE_MS = 60 * 60 * 1000;

/**
 * Dispara a atualização do mapa em background (fire-and-forget).
 * Nunca bloqueia o caminho do alerta; erros são ignorados de propósito.
 */
function triggerBackgroundRefresh() {
  const now = Date.now();
  if (now - lastRefreshAttemptMs < REFRESH_THROTTLE_MS) return;
  lastRefreshAttemptMs = now;
  try {
    const child = spawn('node', [UPDATER_SCRIPT], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // ignore: refresh é best-effort
    child.unref();
  } catch (_) {
    // ignore
  }
}

/**
 * Busca informações de uma estação pelo ID
 * @param {string} chargerId - ID do carregador (ex: "AR2510070008")
 * @returns {object|null} - Dados da estação ou null se não encontrado
 */
function lookupStation(chargerId) {
  try {
    if (!fs.existsSync(STATIONS_MAP_FILE)) {
      triggerBackgroundRefresh(); // mapa ausente: tenta popular para a próxima vez
      return null;
    }

    // Mantém o arquivo fresco sem cron: refresh em background se >48h.
    if (isStale()) {
      triggerBackgroundRefresh();
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

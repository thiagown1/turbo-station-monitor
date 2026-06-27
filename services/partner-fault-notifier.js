#!/usr/bin/env node
/**
 * partner-fault-notifier.js
 *
 * Sends partner-facing (human-friendly) fault alerts to partner WhatsApp groups.
 *
 * TEST MODE (default / PARTNER_ALERT_MODE=test):
 *   Sends to the internal notifications group with a banner at the top:
 *   "🔔 [TESTE — Seria enviado para: <Partner Name> (<Group Name>)]"
 *   This lets the team review and approve every template before going live.
 *
 * LIVE MODE (PARTNER_ALERT_MODE=live):
 *   Resolves each station's partnerId → group conversation via the
 *   support-copilot `groups/by-partner` lookup, then sends directly to the
 *   partner's WhatsApp group.
 *
 * Partner config lives in config/partner-alert-stations.json (gitignored).
 * See config/partner-alert-stations.json.example for the schema.
 *
 * Fault scenarios handled:
 *   secc_can_offline   - SECC CAN bus failure (often triggered by dual-connector load)
 *   connector_fault    - specific connector is faulted
 *   station_offline    - charger unavailable / no communication
 *   generic_fault      - any other Faulted status
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { lookupStation } = require('./station-lookup');
const { parseStatusNotif } = require('./ocpp-utils');

const PARTNER_CONFIG_FILE = path.join(__dirname, '..', 'config', 'partner-alert-stations.json');
const IS_TEST_MODE = (process.env.PARTNER_ALERT_MODE || 'test') !== 'live';

// Same transport as alert-engine.js
const SUPPORT_API_BASE = (process.env.SUPPORT_API_URL || 'https://logs.turbostation.com.br').replace(/\/+$/, '');
const SUPPORT_API_SECRET = process.env.SUPPORT_API_SECRET || process.env.MONITOR_API_SECRET || '';
const WHATSAPP_CONV = process.env.ALERT_WHATSAPP_CONV !== undefined
    ? process.env.ALERT_WHATSAPP_CONV
    : 'conv_jiuijxjtmnet23i9';
const WHATSAPP_BRAND = process.env.ALERT_WHATSAPP_BRAND || 'turbo_station';

// Partner alerts are more disruptive than internal ones — 2h debounce per
// charger+scenario so a flapping connector doesn't spam a partner group.
const PARTNER_DEBOUNCE_MS = 2 * 60 * 60 * 1000;
const DEBOUNCE_FILE = path.join(__dirname, '..', 'history', 'partner_alert_debounce.json');

// ─── Partner config ──────────────────────────────────────────────────────────

function loadPartnerConfig() {
    try {
        if (!fs.existsSync(PARTNER_CONFIG_FILE)) return { stations: {} };
        return JSON.parse(fs.readFileSync(PARTNER_CONFIG_FILE, 'utf-8'));
    } catch (e) {
        console.warn('[partner-alert] no config loaded:', e.message);
        return { stations: {} };
    }
}

// ─── Debounce ────────────────────────────────────────────────────────────────

function loadDebounce() {
    try {
        if (fs.existsSync(DEBOUNCE_FILE)) return JSON.parse(fs.readFileSync(DEBOUNCE_FILE, 'utf-8'));
    } catch (_) {}
    return {};
}

function saveDebounce(cache) {
    try { fs.writeFileSync(DEBOUNCE_FILE, JSON.stringify(cache, null, 2)); } catch (_) {}
}

let _debounce = loadDebounce();

function isDebounced(key) {
    const last = _debounce[key];
    if (!last) return false;
    const age = Date.now() - last;
    if (age < PARTNER_DEBOUNCE_MS) {
        console.log(`[partner-alert] debounced: ${key} (sent ${Math.round(age / 60000)}m ago)`);
        return true;
    }
    return false;
}

function markSent(key) {
    _debounce[key] = Date.now();
    saveDebounce(_debounce);
}

// ─── Fault classification ─────────────────────────────────────────────────────

const SCENARIO = {
    SECC_CAN_OFFLINE: 'secc_can_offline',
    CONNECTOR_FAULT: 'connector_fault',
    STATION_OFFLINE: 'station_offline',
    GENERIC_FAULT: 'generic_fault',
};

function classifyFault(parsed, rawMessage) {
    const hay = [parsed.info || '', parsed.vendorError || '', rawMessage || ''].join(' ');
    if (/secc.*(can|offline)|can.*offline/i.test(hay)) return SCENARIO.SECC_CAN_OFFLINE;
    if (parsed.connectorId != null && parsed.status === 'Faulted') return SCENARIO.CONNECTOR_FAULT;
    if (/unavailable|disconnected/i.test(hay)) return SCENARIO.STATION_OFFLINE;
    return SCENARIO.GENERIC_FAULT;
}

// ─── Message templates (Portuguese, partner-friendly) ─────────────────────────

function timeBRT(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
    });
}

function buildPartnerMessage(scenario, parsed, stationName, eventTs) {
    const hora = timeBRT(eventTs);
    const connLabel = parsed.connectorId != null ? `Conector ${parsed.connectorId}` : 'conector';

    switch (scenario) {
        case SCENARIO.SECC_CAN_OFFLINE:
            return [
                `⚡ *Carregador com instabilidade — ${stationName}*`,
                '',
                `Identificamos uma falha no *${connLabel}* do carregador às ${hora} (horário de Brasília).`,
                '',
                `Isso pode ocorrer quando dois veículos tentam carregar ao mesmo tempo e o sistema de gestão de energia enfrenta uma instabilidade.`,
                '',
                `Nossa equipe foi notificada e está acompanhando. Geralmente o carregador se recupera em alguns minutos.`,
                '',
                `Se o equipamento ainda mostrar erro após 15 minutos, nos avise.`,
                '',
                `📞 Suporte Turbo Station: suporte@turbostation.com.br`,
            ].join('\n');

        case SCENARIO.CONNECTOR_FAULT:
            return [
                `⚡ *Falha no carregador — ${stationName}*`,
                '',
                `O *${connLabel}* apresentou falha às ${hora} (horário de Brasília).`,
                '',
                `Usuários que tentarem iniciar uma sessão nesse conector receberão um aviso no aplicativo.`,
                '',
                `Nossa equipe técnica foi notificada e está verificando. Avisaremos assim que o equipamento estiver normalizado.`,
                '',
                `📞 Suporte Turbo Station: suporte@turbostation.com.br`,
            ].join('\n');

        case SCENARIO.STATION_OFFLINE:
            return [
                `⚡ *Carregador sem comunicação — ${stationName}*`,
                '',
                `O carregador está sem comunicação com nossa central desde ${hora} (horário de Brasília).`,
                '',
                `Possíveis causas: queda de energia, problema de rede ou falha temporária. Nossa equipe está verificando.`,
                '',
                `Se possível, confirme se o carregador está energizado e se há alguma luz de alerta no equipamento.`,
                '',
                `📞 Suporte Turbo Station: suporte@turbostation.com.br`,
            ].join('\n');

        default: // generic_fault
            return [
                `⚡ *Falha no carregador — ${stationName}*`,
                '',
                `O carregador (${connLabel}) apresentou uma falha às ${hora} (horário de Brasília).`,
                '',
                `Nossa equipe técnica foi notificada e está verificando. Avisaremos assim que o equipamento estiver normalizado.`,
                '',
                `📞 Suporte Turbo Station: suporte@turbostation.com.br`,
            ].join('\n');
    }
}

// ─── Transport ────────────────────────────────────────────────────────────────

async function postToConversation(conversationId, brandId, text) {
    if (!SUPPORT_API_SECRET) {
        console.warn('[partner-alert] SUPPORT_API_SECRET not set — cannot send');
        return false;
    }
    try {
        const url = `${SUPPORT_API_BASE}/api/support/conversations/${encodeURIComponent(conversationId)}/messages?brandId=${encodeURIComponent(brandId)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-secret': SUPPORT_API_SECRET,
                'x-brand-id': brandId,
            },
            body: JSON.stringify({ body: text, source: 'system' }),
        });
        if (!res.ok) {
            console.error(`[partner-alert] POST failed: ${res.status} conv=${conversationId}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error('[partner-alert] fetch error:', e && e.message);
        return false;
    }
}

async function resolvePartnerConversationId(partnerId, brandId) {
    if (!SUPPORT_API_SECRET) return null;
    try {
        const url = `${SUPPORT_API_BASE}/api/support/groups/by-partner?partnerId=${encodeURIComponent(partnerId)}&brandId=${encodeURIComponent(brandId)}`;
        const res = await fetch(url, {
            headers: { 'x-api-secret': SUPPORT_API_SECRET },
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        if (!data || !data.conversationId || data.enabled === false) return null;
        return data.conversationId;
    } catch (e) {
        console.error('[partner-alert] resolve group failed:', e && e.message);
        return null;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Notify the relevant partner of a charger fault.
 *
 * @param {object} fault - The alert object returned by detectChargerFaults()
 *                         Must include: charger_id, evidence_json, event_ts,
 *                         and optionally parsed_fault (pre-parsed StatusNotif fields).
 */
async function notifyPartnerFault(fault) {
    if (!WHATSAPP_CONV && IS_TEST_MODE) {
        console.warn('[partner-alert] ALERT_WHATSAPP_CONV not set — skipping');
        return;
    }

    const config = loadPartnerConfig();
    const stationEntry = (config.stations || {})[fault.charger_id];

    if (!stationEntry) {
        console.log(`[partner-alert] no partner config for ${fault.charger_id} — skipping`);
        return;
    }

    const {
        partnerName,
        partnerId,
        brandId = WHATSAPP_BRAND,
        groupName,
    } = stationEntry;

    // Re-use pre-parsed fields if the alert already has them, otherwise re-parse.
    const parsed = fault.parsed_fault || (() => {
        try {
            const ev = JSON.parse(fault.evidence_json || '{}');
            const msg = ev.ocpp && ev.ocpp.event ? ev.ocpp.event.message : '';
            return parseStatusNotif(msg);
        } catch (_) {
            return {};
        }
    })();

    const rawMessage = (() => {
        try {
            const ev = JSON.parse(fault.evidence_json || '{}');
            return ev.ocpp && ev.ocpp.event ? ev.ocpp.event.message : '';
        } catch (_) { return ''; }
    })();

    const scenario = classifyFault(parsed, rawMessage);
    const debounceKey = `partner::${fault.charger_id}::${scenario}`;

    if (isDebounced(debounceKey)) return;

    const station = lookupStation(fault.charger_id);
    const stationName = station ? station.name : (stationEntry.stationName || fault.charger_id);
    const partnerMsg = buildPartnerMessage(scenario, parsed, stationName, fault.event_ts || Date.now());

    if (IS_TEST_MODE) {
        const label = groupName ? `${partnerName} (${groupName})` : partnerName;
        const text = `🔔 *[TESTE — Seria enviado para: ${label}]*\n${'─'.repeat(40)}\n\n${partnerMsg}`;
        const sent = await postToConversation(WHATSAPP_CONV, WHATSAPP_BRAND, text);
        if (sent) {
            markSent(debounceKey);
            console.log(`[partner-alert][TEST] sent for ${fault.charger_id} (${scenario}) to internal group`);
        }
    } else {
        if (!partnerId) {
            console.warn(`[partner-alert] partnerId missing for ${fault.charger_id} — cannot route in live mode`);
            return;
        }
        const convId = await resolvePartnerConversationId(partnerId, brandId);
        if (!convId) {
            console.warn(`[partner-alert] no linked group for partnerId=${partnerId}`);
            return;
        }
        const sent = await postToConversation(convId, brandId, partnerMsg);
        if (sent) {
            markSent(debounceKey);
            console.log(`[partner-alert][LIVE] sent for ${fault.charger_id} (${scenario}) to ${partnerName}`);
        }
    }
}

module.exports = { notifyPartnerFault, classifyFault, buildPartnerMessage, SCENARIO };

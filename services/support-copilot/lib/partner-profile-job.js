'use strict';

/**
 * Daily partner profile (the partner assistant's shared memory).
 *
 * Once a day, for every WhatsApp group linked to a partner, reads only the
 * messages that arrived since the last run, plus each partner's dashboard chat
 * turns since the last run, and asks a cheap model to update each linked
 * partner's short profile from its current version (read from the app, so
 * team edits in the dashboard are kept). A partner with nothing new is skipped. The result is written through
 * POST /api/agents/partner-memory `upsert_profile`, which versions and audits it.
 *
 * Off unless PARTNER_PROFILE_JOB_ENABLED=true; the app side also refuses writes
 * while agents.partnerAssistant is off. Never throws into the caller.
 */

const { db, nowIso } = require('./db');
const { redact } = require('./partner-assistant-runtime');

const LOG_TAG = '[partner-profile]';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const RUN_HOUR_BRASILIA = 3;
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const MAX_MESSAGES = 300;
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_GROUPS_PER_RUN = 30;
const SECTIONS = ['momento', 'estacoes', 'dificuldades', 'pedidosAbertos', 'compromissosEquipe', 'relacionamento'];

function baseUrl() { return String(process.env.AGENT_EVENT_BASE_URL || '').replace(/\/$/, ''); }
function secret() { return process.env.PARTNER_AGENT_SECRET || ''; }
function model() { return process.env.PARTNER_PROFILE_MODEL || 'deepseek/deepseek-v4-flash'; }
function jobEnabled(env = process.env) { return env.PARTNER_PROFILE_JOB_ENABLED === 'true'; }

function brasiliaParts(date) {
  const shifted = new Date(date.getTime() - 3 * 60 * 60_000);
  return { day: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}

function linkedGroups() {
  return db.prepare(`SELECT DISTINCT conversation_id, group_jid, brand_id FROM group_partner_links
      WHERE enabled = 1 AND conversation_id IS NOT NULL AND conversation_id <> ''
      ORDER BY conversation_id LIMIT ?`).all(MAX_GROUPS_PER_RUN);
}

function watermarks(conversationId, now) {
  const row = db.prepare('SELECT last_message_at, last_dashboard_at FROM partner_profile_runs WHERE conversation_id = ?').get(conversationId);
  const firstRun = new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
  return { messagesSince: row?.last_message_at || firstRun, dashboardSince: row?.last_dashboard_at || firstRun };
}

function newMessages(conversationId, since) {
  return db.prepare(`SELECT direction, sender_name, body, created_at FROM messages
      WHERE conversation_id = ? AND created_at > ? AND body IS NOT NULL AND body <> ''
      ORDER BY created_at ASC LIMIT ?`).all(conversationId, since, MAX_MESSAGES);
}

function transcript(rows) {
  const lines = rows.map((row) => {
    const at = new Date(row.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    const who = row.direction === 'outbound' ? 'Turbo Station' : (row.sender_name || 'Parceiro');
    return `[${at}] ${who}: ${redact(String(row.body).replace(/^\[[^\]]*\]:\s*/, '')).slice(0, 600)}`;
  });
  let text = lines.join('\n');
  // Keep the most recent part when the day was very busy.
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(text.length - MAX_TRANSCRIPT_CHARS);
  return text;
}


function dashboardTranscript(turns) {
  return turns.map((turn) => {
    const at = new Date(turn.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    // The app already sends short notes without amounts; keep who asked.
    const who = turn.askedBy ? String(turn.askedBy).slice(0, 80) : 'parceiro';
    // Never consume answers, including legacy payloads: group capabilities
    // may not permit the information returned by the dashboard assistant.
    return `[${at}] Dashboard: ${who} perguntou: ${redact(String(turn.question)).slice(0, 400)}`;
  }).join('\n');
}

const SYSTEM_PROMPT = `Você mantém a ficha de um parceiro da Turbo Station (dono ou anfitrião de estações de recarga de carros elétricos).
Atualize a ficha a partir da ficha atual, das mensagens novas do grupo de WhatsApp com esse parceiro e das perguntas novas que ele fez no chat do dashboard.
Regras:
- O próprio parceiro pode ler a ficha (no WhatsApp e no dashboard): escreva de forma factual e respeitosa, sem julgamentos sobre ele.
- Só fatos que aparecem nas mensagens ou na ficha atual; nada inventado.
- Sem dados pessoais: nenhum telefone, CPF, e-mail, endereço de pessoa, valor pago por usuário final ou nome de cliente final.
- Sem valores financeiros (receita, repasse, preços pagos): registre só o assunto, por exemplo "Luan perguntou se o faturamento do Caju Limão está caindo".
- Pode dizer quem da equipe do parceiro perguntou o quê, pelo primeiro nome.
- Mantenha o que continua válido da ficha atual; tire o que foi resolvido ou ficou velho; seja curto.
- Responda só JSON: {"summary": "até 600 caracteres", "sections": {"momento": "...", "estacoes": "...", "dificuldades": "...", "pedidosAbertos": "...", "compromissosEquipe": "...", "relacionamento": "..."}}.
- Cada seção tem até 400 caracteres; omita a seção quando não houver nada a dizer.`;

function validateProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('profile_not_object');
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 1200) : '';
  if (!summary) throw new Error('profile_without_summary');
  const sections = {};
  for (const key of SECTIONS) {
    const value = raw.sections && typeof raw.sections[key] === 'string' ? raw.sections[key].trim() : '';
    if (value) sections[key] = redact(value).slice(0, 800);
  }
  return { summary: redact(summary), sections };
}

async function summarizeWithModel({ partnerName, current, messages }, deps = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('profile_model_unconfigured');
  const res = await (deps.request || fetch)(OPENROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model(),
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ parceiro: partnerName, fichaAtual: current, mensagensNovas: messages }) },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`profile_model_http_${res.status}`);
  const body = await res.json();
  return validateProfile(JSON.parse(body.choices?.[0]?.message?.content || '{}'));
}

async function postMemory(body, deps = {}) {
  if (!baseUrl() || !secret()) throw new Error('partner_memory_unconfigured');
  const res = await (deps.request || fetch)(`${baseUrl()}/api/agents/partner-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`partner_memory_http_${res.status}:${json.error || ''}`);
  return json;
}

function recordRun(conversationId, patch) {
  db.prepare(`INSERT INTO partner_profile_runs (conversation_id, last_message_at, last_run_at, last_status, last_error)
      VALUES (@conversationId, @lastMessageAt, @at, @status, @error)
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_message_at = COALESCE(@lastMessageAt, partner_profile_runs.last_message_at),
        last_run_at = @at, last_status = @status, last_error = @error`)
    .run({ conversationId, lastMessageAt: patch.lastMessageAt ?? null, at: nowIso(), status: patch.status, error: patch.error ?? null });
  if (patch.lastDashboardAt) {
    db.prepare('UPDATE partner_profile_runs SET last_dashboard_at = ? WHERE conversation_id = ?').run(patch.lastDashboardAt, conversationId);
  }
}

/** Updates the profiles of one group's partners. Returns a status string. */
async function updateGroupProfiles(group, deps = {}, now = new Date()) {
  const { messagesSince, dashboardSince } = watermarks(group.conversation_id, now);
  const rows = newMessages(group.conversation_id, messagesSince);
  const subject = { type: 'whatsapp_group', conversationId: group.conversation_id };
  try {
    const { partners = [] } = await postMemory({ brandId: group.brand_id, subject, action: 'read_profiles', dashboardSince }, deps);
    const groupText = rows.length ? transcript(rows) : '';
    let updated = 0;
    let lastDashboardAt = null;
    for (const partner of partners) {
      const turns = Array.isArray(partner.dashboardTurns) ? partner.dashboardTurns : [];
      if (!groupText && !turns.length) continue;
      const content = await (deps.summarize || summarizeWithModel)({
        partnerName: partner.name,
        current: partner.profile ? { summary: partner.profile.summary, sections: partner.profile.sections } : null,
        messages: [groupText, dashboardTranscript(turns)].filter(Boolean).join('\n'),
      }, deps);
      await postMemory({ brandId: group.brand_id, subject, action: 'upsert_profile', partnerId: partner.id, profile: content }, deps);
      updated += 1;
      for (const turn of turns) if (!lastDashboardAt || turn.at > lastDashboardAt) lastDashboardAt = turn.at;
    }
    if (!updated) {
      recordRun(group.conversation_id, { status: 'no_new_messages' });
      return 'no_new_messages';
    }
    recordRun(group.conversation_id, { status: 'ok', lastMessageAt: rows.length ? rows[rows.length - 1].created_at : null, lastDashboardAt });
    return 'ok';
  } catch (error) {
    // Keep last_message_at so the next run retries the same messages.
    recordRun(group.conversation_id, { status: 'failed', error: String(error?.message || error).slice(0, 300) });
    console.warn(`${LOG_TAG} ${group.conversation_id} failed:`, error.message);
    return 'failed';
  }
}

/** Runs once per Brasília day, after 03:00, when enabled. Safe to call often. */
async function maybeRunDailyPartnerProfiles(deps = {}, now = new Date()) {
  if (!jobEnabled(deps.env)) return { ran: false, reason: 'disabled' };
  const { day, hour } = brasiliaParts(now);
  if (hour < RUN_HOUR_BRASILIA) return { ran: false, reason: 'too_early' };
  const claimed = db.prepare(`INSERT OR IGNORE INTO partner_profile_daily (run_date, status, started_at) VALUES (?, 'running', ?)`).run(day, nowIso());
  if (claimed.changes !== 1) return { ran: false, reason: 'already_ran' };
  const results = {};
  for (const group of linkedGroups()) {
    results[group.conversation_id] = await updateGroupProfiles(group, deps, now);
  }
  const failed = Object.values(results).filter((status) => status === 'failed').length;
  db.prepare(`UPDATE partner_profile_daily SET status = ?, finished_at = ?, summary_json = ? WHERE run_date = ?`)
    .run(failed ? 'partial' : 'done', nowIso(), JSON.stringify(results), day);
  console.log(`${LOG_TAG} ${day}: ${Object.keys(results).length} groups, ${failed} failed`);
  return { ran: true, results };
}

module.exports = {
  SYSTEM_PROMPT,
  maybeRunDailyPartnerProfiles,
  transcript,
  updateGroupProfiles,
  validateProfile,
};

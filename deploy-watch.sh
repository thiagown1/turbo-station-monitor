#!/usr/bin/env bash
# Deploy watch for ocpp_server prod deploys. Announces start/end to the alert
# group and alerts on charger-count drop or ingest stall during the window.
# Usage: deploy-watch.sh <version> [duration_min] [--no-send]
set -u
cd "$(dirname "$0")"
DB=db/ocpp.db
GROUP="120363426100393587@g.us"
GW="http://localhost:3006/message/sendText/turbo_station"
VERSION="${1:-unknown}"
DUR_MIN="${2:-15}"
NOSEND="${3:-}"
DROP_PCT=25          # alert if active chargers fall >25% vs baseline
STALL_SEC=180        # alert if no OCPP events for >180s

now_ms(){ echo $(( $(date +%s) * 1000 )); }
active(){ sqlite3 "$DB" "SELECT COUNT(DISTINCT charger_id) FROM ocpp_events WHERE timestamp >= $(now_ms)-300000 AND charger_id!='';"; }
stale(){ local s; s=$(sqlite3 "$DB" "SELECT ($(now_ms)-MAX(timestamp))/1000 FROM ocpp_events;"); echo "${s#-}"; }
send(){ [ "$NOSEND" = "--no-send" ] && { echo "[dry-run] $1"; return; }; curl -s -o /dev/null -w "send=%{http_code}\n" -X POST "$GW" -H 'Content-Type: application/json' --data "$(python3 -c 'import json,sys;print(json.dumps({"number":sys.argv[1],"text":sys.argv[2]}))' "$GROUP" "$1")"; }

BASE=$(active)
send "🚀 Deploy iniciado: ocpp_server v${VERSION}. Baseline: ${BASE} chargers ativos. Vou monitorar por ${DUR_MIN}min e aviso se houver regressão."
echo "baseline=$BASE duration=${DUR_MIN}m"
THRESH=$(( BASE * (100-DROP_PCT) / 100 ))
END=$(( $(date +%s) + DUR_MIN*60 ))
drop_alerted=0; stall_alerted=0; worst=$BASE
while [ $(date +%s) -lt $END ]; do
  sleep 60
  CUR=$(active); ST=$(stale)
  [ "$CUR" -lt "$worst" ] && worst=$CUR
  echo "$(date +%H:%M:%S) active=$CUR stale=${ST}s thresh=$THRESH"
  if [ "$ST" -gt "$STALL_SEC" ] && [ "$stall_alerted" -eq 0 ]; then
    send "⚠️ Deploy v${VERSION}: ingest OCPP parado há ${ST}s — servidor pode ter caído. Verificar / considerar rollback (rollback_ocpp_prod.sh)."; stall_alerted=1
  fi
  if [ "$CUR" -lt "$THRESH" ] && [ "$drop_alerted" -eq 0 ]; then
    send "⚠️ Deploy v${VERSION}: chargers ativos caíram ${BASE}→${CUR} (>${DROP_PCT}%) — possível regressão. Considerar rollback."; drop_alerted=1
  fi
done
CUR=$(active)
if [ "$drop_alerted" -eq 0 ] && [ "$stall_alerted" -eq 0 ]; then
  send "✅ Deploy v${VERSION} estável: ${CUR} chargers ativos (baseline ${BASE}, mínimo ${worst}). Ingest ok, sem regressão."
else
  send "⚠️ Deploy v${VERSION} terminou COM alertas (mín ${worst}/${BASE} chargers). Revisar antes de considerar concluído."
fi

# --- Agent-generated deploy report (claude -p over the window's OCPP events) ---
report_agent(){
  export PATH=/home/openclaw/.npm-global/bin:$PATH
  local winstart=$(( ($(date +%s) - DUR_MIN*60) * 1000 ))
  local digest
  digest=$(sqlite3 "$DB" "
    SELECT 'ERROS/WARN por categoria/severity:';
    SELECT '  '||COALESCE(category,'?')||' / '||COALESCE(severity,'?')||': '||COUNT(*)
      FROM ocpp_events
      WHERE timestamp>=$winstart AND severity IN ('error','warning','critical')
      GROUP BY category,severity ORDER BY COUNT(*) DESC LIMIT 12;
    SELECT 'Amostra de erros:';
    SELECT '  '||substr(replace(message,char(10),' '),1,160)
      FROM ocpp_events
      WHERE timestamp>=$winstart AND severity IN ('error','critical')
      ORDER BY timestamp DESC LIMIT 8;
    SELECT 'Chargers ativos agora: '||COUNT(DISTINCT charger_id)
      FROM ocpp_events WHERE timestamp>=$(now_ms)-300000 AND charger_id!='';
  " 2>/dev/null)
  [ -z "$digest" ] && digest="(sem eventos no DB para a janela)"
  local prompt="Voce e um SRE analisando um deploy do servidor OCPP (producao, carregadores de carro eletrico). Versao: v${VERSION}. Baseline chargers: ${BASE}, minimo na janela: ${worst}, agora: ${CUR}. Abaixo um resumo dos eventos OCPP dos ultimos ${DUR_MIN} min do banco. Escreva um STATUS curto em pt-BR (max 5 bullets, sem markdown pesado) para um grupo de WhatsApp: veredito (estavel/atencao/critico), erros/anomalias relevantes, tendencia de chargers e se recomenda rollback. Direto e factual, nao invente dados.

DADOS:
${digest}"
  local out
  out=$(claude -p "$prompt" 2>/tmp/deploy-agent-err.log)
  if [ -n "$out" ]; then
    send "🤖 Analise do deploy v${VERSION} (agente):
${out}"
  else
    echo "[agent] claude -p sem saida; ver /tmp/deploy-agent-err.log"
  fi
}
report_agent

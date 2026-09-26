"""Turbo Station partner assistant tools (Hermes profile `parceiro`).

Every data tool calls the app's /api/agents/partner-tools endpoint. The app
resolves which partner and which stations the conversation may see; this plugin
only proves *which conversation* is asking. That subject never comes from the
model's arguments:

- WhatsApp gateway: not wired yet — data tools fail closed.
- CLI (`hermes -p parceiro chat -Q -q ...`): the conversation id comes from the
  TURBO_PARCEIRO_CONVERSATION_ID environment variable set by the operator or
  the eval harness, and is honored only when the session is not a gateway one.

`parceiro_conhecimento` is a local keyword search over the Markdown files in
`knowledge/` (the profile's RAG base). Nothing here writes or sends anything.
Secrets are read from the profile's .env at call time and never reach the model.
"""

from __future__ import annotations

import json
import math
import os
import re
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

PROFILE_DIR = Path(__file__).resolve().parents[2]
ENV_FILE = PROFILE_DIR / ".env"
KNOWLEDGE_DIR = PROFILE_DIR / "knowledge"
TIMEOUT = 90
BRAND_ID = "turbo_station"
CLI_PLATFORMS = {"", "cli"}
USAGE_PERIODS = ["today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month"]


# ---------------------------------------------------------------------------
# Config, session, subject
# ---------------------------------------------------------------------------

def _env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _session_platform() -> str:
    try:
        from gateway.session_context import get_session_env
    except Exception:  # CLI / tests without the gateway package
        return ""
    return (get_session_env("HERMES_SESSION_PLATFORM", "") or "").strip().lower()


def resolve_subject(platform: str | None = None, environ: dict | None = None) -> dict | None:
    """The conversation the current turn belongs to, or None (fail closed)."""
    platform = _session_platform() if platform is None else platform.strip().lower()
    environ = os.environ if environ is None else environ
    if platform in CLI_PLATFORMS:
        conversation_id = str(environ.get("TURBO_PARCEIRO_CONVERSATION_ID", "")).strip()
        if re.fullmatch(r"conv_[A-Za-z0-9]{6,64}", conversation_id):
            return {"type": "whatsapp_group", "conversationId": conversation_id}
    return None


def _trace(entry: dict) -> None:
    """Eval harness hook: append tool calls to a JSONL file (CLI only)."""
    path = os.environ.get("TURBO_PARCEIRO_TRACE_FILE", "").strip()
    if not path or _session_platform() not in CLI_PLATFORMS:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# App calls
# ---------------------------------------------------------------------------

def _post(body: dict) -> tuple[int, dict]:
    env = _env()
    base = env.get("TURBO_PARTNER_TOOLS_BASE_URL", "https://www.turbostation.com.br").rstrip("/")
    secret = env.get("TURBO_PARTNER_AGENT_SECRET", "")
    if not secret:
        return 0, {"ok": False, "error": "not_configured", "message": "Assistente sem credencial configurada."}
    req = urllib.request.Request(f"{base}/api/agents/partner-tools", data=json.dumps(body).encode(), method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("accept", "application/json")
    req.add_header("authorization", f"Bearer {secret}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read() or b"{}")
        except ValueError:
            payload = {}
        return err.code, payload
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, {"ok": False, "error": "unavailable", "message": "Sistema indisponível no momento."}


def call_partner_tool(tool: str, args: dict, subject: dict | None = None, post=None) -> dict:
    subject = resolve_subject() if subject is None else subject
    if not subject:
        result = {"ok": False, "error": "no_subject",
                  "message": "Esta conversa não está vinculada a um parceiro; não posso consultar dados de estações."}
    else:
        status, payload = (post or _post)({"brandId": BRAND_ID, "subject": subject, "tool": tool, "args": args})
        if status == 200 and isinstance(payload, dict):
            result = payload
        else:
            error = payload.get("error") if isinstance(payload, dict) else None
            result = {"ok": False, "error": error or f"http_{status}",
                      "message": {
                          "disabled": "O assistente de parceiros está desligado no momento.",
                          "no_scope": "Este grupo não tem estações vinculadas.",
                          "scope_unavailable": "Não consegui confirmar as estações deste grupo agora.",
                      }.get(error or "", "Não consegui consultar o sistema agora.")}
    _trace({"tool": tool, "args": args, "ok": bool(result.get("ok")), "error": result.get("error"),
            "result": json.dumps(result, ensure_ascii=False)[:8000]})
    return result


def _dump(result: dict) -> str:
    return json.dumps(result, ensure_ascii=False)


def estacoes(args: dict | None = None, **_) -> str:
    return _dump(call_partner_tool("partner_overview", {}))


def status_estacao(args: dict | None = None, **_) -> str:
    args = args or {}
    station = str(args.get("estacao") or "").strip()
    return _dump(call_partner_tool("station_status", {"station": station} if station else {}))


def uso(args: dict | None = None, **_) -> str:
    args = args or {}
    payload: dict = {"period": str(args.get("periodo") or "last_7_days")}
    station = str(args.get("estacao") or "").strip()
    if station:
        payload["station"] = station
    return _dump(call_partner_tool("station_usage", payload))


# ---------------------------------------------------------------------------
# Knowledge base (RAG): BM25 over Markdown sections
# ---------------------------------------------------------------------------

_STOP = set("a o e de da do das dos em no na nos nas um uma para por com que se ao aos as os eu voce voces ele ela".split())


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", _fold(text)) if len(t) > 1 and t not in _STOP]


def _partner_facing(text: str) -> str:
    """Drop authoring metadata the partner must never see: YAML front matter,
    `PENDENTE:` notes for the business owner and the `Fontes:` source list."""
    text = re.sub(r"\A---\n.*?\n---\n", "", text.replace("\r\n", "\n"), flags=re.S)
    kept = [p for p in re.split(r"\n\s*\n", text) if not re.match(r"\s*(PENDENTE|Fontes)\s*:", p)]
    return "\n\n".join(kept)


def _chunks(directory: Path) -> list[dict]:
    chunks: list[dict] = []
    for path in sorted(directory.glob("*.md")):
        text = _partner_facing(path.read_text(encoding="utf-8"))
        title = next((line.lstrip("# ").strip() for line in text.splitlines() if line.startswith("# ")), path.stem)
        for section in re.split(r"\n(?=## )", text):
            body = section.strip()
            if not body:
                continue
            heading = body.splitlines()[0].lstrip("# ").strip()
            chunks.append({"source": path.name, "title": title, "section": heading, "text": body[:1800]})
    return chunks


def search_knowledge(query: str, directory: Path = KNOWLEDGE_DIR, limit: int = 3) -> list[dict]:
    chunks = _chunks(directory) if directory.exists() else []
    query_terms = _tokens(query)
    if not chunks or not query_terms:
        return []
    docs = [_tokens(f"{c['title']} {c['section']} {c['text']}") for c in chunks]
    avg_len = sum(len(d) for d in docs) / len(docs)
    df = {term: sum(1 for d in docs if term in d) for term in set(query_terms)}
    scored = []
    for chunk, doc in zip(chunks, docs):
        score = 0.0
        for term in query_terms:
            tf = doc.count(term)
            if not tf:
                continue
            idf = math.log(1 + (len(docs) - df[term] + 0.5) / (df[term] + 0.5))
            score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * len(doc) / avg_len))
        if score > 0:
            scored.append((score, chunk))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [dict(chunk, score=round(score, 2)) for score, chunk in scored[:limit]]


def conhecimento(args: dict | None = None, **_) -> str:
    query = str((args or {}).get("pergunta") or "").strip()
    hits = search_knowledge(query)
    _trace({"tool": "knowledge", "args": {"pergunta": query}, "ok": bool(hits), "error": None if hits else "no_hits",
            "result": json.dumps([{k: h[k] for k in ("source", "section", "text")} for h in hits], ensure_ascii=False)[:8000]})
    if not hits:
        return _dump({"ok": False, "error": "no_hits", "message": "Nada na base de conhecimento sobre isso."})
    return _dump({"ok": True, "trechos": [{k: h[k] for k in ("source", "section", "text")} for h in hits]})


# ---------------------------------------------------------------------------
# WhatsApp formatting (deterministic; the model keeps emitting Markdown)
# ---------------------------------------------------------------------------

# The cheap model occasionally emits a broken tool call as plain text
# ("<use tool_reference>", "<function...", JSON tool envelopes). Never let that
# reach a partner.
_TOOL_CALL_RESIDUE = re.compile(
    r"<\s*/?\s*(use[ _]tool|tool_reference|function|invoke|tool_call|parameter|parceiro_tool)|\"name\"\s*:\s*\"parceiro_",
    re.I,
)
FALLBACK_REPLY = "Não consegui consultar isso agora. Pode repetir a pergunta? Se preferir, a equipe verifica por aqui."


def whatsapp_format(response_text: str = "", **kwargs):
    """Rewrite Markdown into WhatsApp markup. Returns None when nothing changed."""
    del kwargs
    text = response_text or ""
    if _TOOL_CALL_RESIDUE.search(text):
        return FALLBACK_REPLY
    out = re.sub(r"\*\*(.+?)\*\*", r"*\g<1>*", text, flags=re.S)
    out = re.sub(r"__(.+?)__", r"_\g<1>_", out, flags=re.S)
    out = re.sub(r"(?m)^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", r"*\g<1>*", out)
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r"\g<1> (\g<2>)", out)
    return out if out != text else None


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

ESTACOES_SCHEMA = {
    "name": "parceiro_estacoes",
    "description": "Lista as estações do parceiro deste grupo (nome, cidade) e o que o grupo pode consultar de cada uma. Use antes de responder sobre 'minhas estações' ou quando não souber o nome exato.",
    "parameters": {"type": "object", "properties": {}},
}
STATUS_SCHEMA = {
    "name": "parceiro_status_estacao",
    "description": "Situação atual das estações do parceiro: saúde, comunicação, conectores, recargas em andamento e falhas das últimas 24h. Com o nome/ID consulta uma; vazio consulta todas as do grupo de uma vez (até 5).",
    "parameters": {"type": "object", "properties": {
        "estacao": {"type": "string", "description": "Nome (ou parte) ou ID da estação, como o parceiro escreveu. Vazio = todas."},
    }},
}
USO_SCHEMA = {
    "name": "parceiro_uso",
    "description": "Recargas, kWh e horas de carregamento das estações do parceiro num período. Receita só aparece se o grupo tiver permissão financeira.",
    "parameters": {"type": "object", "properties": {
        "estacao": {"type": "string", "description": "Nome ou ID. Vazio = todas as estações do grupo."},
        "periodo": {"type": "string", "enum": USAGE_PERIODS, "description": "Período. Padrão last_7_days."},
    }},
}
CONHECIMENTO_SCHEMA = {
    "name": "parceiro_conhecimento",
    "description": "Busca na base de conhecimento da Turbo Station (diagnóstico de estação offline, falhas, repasse e relatório, preços, dashboard, app). Use para dúvidas de 'como funciona' ou 'o que fazer'.",
    "parameters": {"type": "object", "properties": {
        "pergunta": {"type": "string", "description": "A dúvida em poucas palavras."},
    }, "required": ["pergunta"]},
}

_TOOLS = [
    (ESTACOES_SCHEMA, estacoes, "\U0001f50c"),
    (STATUS_SCHEMA, status_estacao, "\U0001f6a6"),
    (USO_SCHEMA, uso, "\U0001f4ca"),
    (CONHECIMENTO_SCHEMA, conhecimento, "\U0001f4da"),
]


def register(ctx):
    ctx.register_hook("transform_llm_output", whatsapp_format)
    for schema, handler, emoji in _TOOLS:
        ctx.register_tool(
            name=schema["name"],
            toolset="turbo_parceiro",
            schema=schema,
            handler=handler,
            description=schema["description"],
            emoji=emoji,
        )

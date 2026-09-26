import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "turbo-parceiro" / "__init__.py"
spec = importlib.util.spec_from_file_location("turbo_parceiro", PLUGIN)
plugin = importlib.util.module_from_spec(spec)
sys.modules["turbo_parceiro"] = plugin
spec.loader.exec_module(plugin)


class ResolveSubjectTest(unittest.TestCase):
    def test_cli_uses_the_operator_supplied_conversation(self):
        subject = plugin.resolve_subject("cli", {"TURBO_PARCEIRO_CONVERSATION_ID": "conv_testgroup0001"})
        self.assertEqual(subject, {"type": "whatsapp_group", "conversationId": "conv_testgroup0001"})

    def test_gateway_sessions_ignore_the_environment_override(self):
        env = {"TURBO_PARCEIRO_CONVERSATION_ID": "conv_testgroup0001"}
        self.assertIsNone(plugin.resolve_subject("whatsapp", env))
        self.assertIsNone(plugin.resolve_subject("api_server", env))

    def test_malformed_conversation_ids_fail_closed(self):
        for value in ["", "conv_", "../conv_x", "conv_abc; rm -rf", "partner:p-arena"]:
            self.assertIsNone(plugin.resolve_subject("cli", {"TURBO_PARCEIRO_CONVERSATION_ID": value}), value)


class CallPartnerToolTest(unittest.TestCase):
    subject = {"type": "whatsapp_group", "conversationId": "conv_testgroup0001"}

    def test_without_subject_nothing_is_requested(self):
        calls = []
        result = plugin.call_partner_tool("partner_overview", {}, subject=False, post=lambda body: calls.append(body))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "no_subject")
        self.assertEqual(calls, [])

    def test_sends_only_the_resolved_subject_and_tool(self):
        sent = {}

        def post(body):
            sent.update(body)
            return 200, {"ok": True, "data": {"stations": []}}

        result = plugin.call_partner_tool("station_status", {"station": "Arena"}, subject=self.subject, post=post)
        self.assertTrue(result["ok"])
        self.assertEqual(sent, {"brandId": "turbo_station", "subject": self.subject, "tool": "station_status", "args": {"station": "Arena"}})

    def test_maps_server_refusals_to_plain_messages(self):
        result = plugin.call_partner_tool("partner_overview", {}, subject=self.subject, post=lambda body: (403, {"ok": False, "error": "disabled"}))
        self.assertEqual(result["error"], "disabled")
        self.assertIn("desligado", result["message"])

    def test_uso_defaults_to_last_seven_days(self):
        captured = {}
        original = plugin.call_partner_tool
        plugin.call_partner_tool = lambda tool, args, **kw: captured.update(tool=tool, args=args) or {"ok": True, "data": {}}
        try:
            plugin.uso({})
        finally:
            plugin.call_partner_tool = original
        self.assertEqual(captured, {"tool": "station_usage", "args": {"period": "last_7_days"}})


class KnowledgeSearchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        (base / "offline.md").write_text(
            "# Estação offline\n\n## Sem internet\nO chip 4G ou o wi-fi caiu; verifique o sinal.\n\n"
            "## Sem energia\nConfira o disjuntor do quadro.\n", encoding="utf-8")
        (base / "repasse.md").write_text(
            "# Repasse\n\n## Relatório de fechamento\nEnviado todo mês com o repasse do parceiro.\n", encoding="utf-8")
        self.base = base

    def tearDown(self):
        self.tmp.cleanup()

    def test_finds_the_relevant_section_ignoring_accents(self):
        hits = plugin.search_knowledge("a estacao ta sem energia, disjuntor?", self.base)
        self.assertEqual(hits[0]["section"], "Sem energia")

    def test_ranks_payout_questions_to_the_report_section(self):
        hits = plugin.search_knowledge("quando chega o relatorio de fechamento", self.base)
        self.assertEqual(hits[0]["source"], "repasse.md")

    def test_returns_nothing_for_unrelated_or_empty_queries(self):
        self.assertEqual(plugin.search_knowledge("", self.base), [])
        self.assertEqual(plugin.search_knowledge("receita de bolo", self.base), [])

    def test_never_returns_owner_notes_sources_or_front_matter(self):
        (self.base / "notas.md").write_text(
            "---\ntitulo: X\n---\n\n# Reinício\n\n## Como reiniciar\nChame a equipe para reiniciar.\n\n"
            "PENDENTE: confirmar procedimento de reinício manual\nno local.\n\nFontes:\n- docs/internal/x.md\n", encoding="utf-8")
        hits = plugin.search_knowledge("como reiniciar procedimento manual", self.base)
        text = " ".join(hit["text"] for hit in hits)
        self.assertIn("Chame a equipe", text)
        for leaked in ("PENDENTE", "Fontes", "docs/internal", "titulo:"):
            self.assertNotIn(leaked, text)

    def test_the_shipped_knowledge_base_is_searchable(self):
        if not plugin.KNOWLEDGE_DIR.exists():
            self.skipTest("knowledge base not present")
        hits = plugin.search_knowledge("estação offline sem internet")
        self.assertTrue(hits)


class WhatsappFormatTest(unittest.TestCase):
    def test_converts_markdown_bold_headings_and_links(self):
        text = "### Status\nA **Arena Norte** está __online__. Veja [o painel](https://www.turbostation.com.br/dashboard)."
        self.assertEqual(
            plugin.whatsapp_format(text),
            "*Status*\nA *Arena Norte* está _online_. Veja o painel (https://www.turbostation.com.br/dashboard).",
        )

    def test_replaces_leaked_tool_call_syntax_with_a_safe_reply(self):
        leaked = '<use tool_reference>\n<function_parceiro_tool_set_ferramenta_tool" string="false">{"name": {"ferramenta_tool"'
        self.assertEqual(plugin.whatsapp_format(leaked), plugin.FALLBACK_REPLY)
        self.assertEqual(plugin.whatsapp_format('{"name": "parceiro_status_estacao", "arguments": {}}'), plugin.FALLBACK_REPLY)

    def test_does_not_flag_normal_answers_mentioning_functions(self):
        self.assertIsNone(plugin.whatsapp_format("A função de reinício remoto fica com a equipe. 📌 Para a equipe: reiniciar a *Arena*."))

    def test_leaves_whatsapp_markup_alone(self):
        self.assertIsNone(plugin.whatsapp_format("A *Arena* está funcionando. Última comunicação 14h32 ✅"))
        self.assertIsNone(plugin.whatsapp_format(""))


class RegistrationTest(unittest.TestCase):
    def test_registers_only_read_only_tools_in_its_toolset(self):
        registered = []

        hooks = []

        class Ctx:
            def register_tool(self, **kw):
                registered.append(kw)

            def register_hook(self, name, fn):
                hooks.append(name)

        plugin.register(Ctx())
        self.assertEqual(hooks, ["transform_llm_output"])
        names = {tool["name"] for tool in registered}
        self.assertEqual(names, {"parceiro_estacoes", "parceiro_status_estacao", "parceiro_uso", "parceiro_conhecimento"})
        self.assertTrue(all(tool["toolset"] == "turbo_parceiro" for tool in registered))
        for tool in registered:
            json.dumps(tool["schema"])  # schemas must be serializable
            self.assertNotIn("partner", json.dumps(tool["schema"]["parameters"]).lower())


if __name__ == "__main__":
    unittest.main()

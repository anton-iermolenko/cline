import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("notifier", Path(__file__).resolve().parents[1] / "notify.py")
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


class Notifications(unittest.TestCase):
    def invoke(self, event, env=None):
        out, err = io.StringIO(), io.StringIO()
        raw = event if isinstance(event, str) else json.dumps(event)
        with patch.dict(os.environ, env or {}, clear=True), patch("sys.stdin", io.StringIO(raw)), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(notifier.main(), 0)
        self.assertEqual(out.getvalue(), "{}\n")
        return err.getvalue()

    def test_completion_and_error_only_send_allowlisted_data(self):
        for event, status in [("agent_end", "completed"), ("agent_error", "error")]:
            text = self.invoke({"hookName": event, "taskId": "PRIVATE", "workspaceRoots": ["PRIVATE"],
                                "error": "PRIVATE", "turn": {"outputText": "PRIVATE"}},
                               {"CLINE_NOTIFY_DRY_RUN": "1"})
            value = json.loads(text)
            self.assertEqual(value["status"], status)
            self.assertEqual(set(value), {"source", "status", "message", "timestamp"})
            self.assertNotIn("PRIVATE", text)

    def test_unrelated_events_are_ignored(self):
        with patch.object(notifier, "send") as send:
            self.assertEqual(self.invoke({"hookName": "tool_result"}), "")
            send.assert_not_called()

    def test_unconfigured_hook_is_inert(self):
        with patch.object(notifier, "send") as send:
            self.assertEqual(self.invoke({"hookName": "agent_end"}), "")
            send.assert_not_called()

    def test_dry_run_never_sends(self):
        with patch.object(notifier, "send") as send:
            self.invoke({"hookName": "agent_end"}, {"CLINE_NOTIFY_DRY_RUN": "1",
                        "CLINE_NOTIFY_WEBHOOK_URL": "https://example.com/api/webhook/PLACEHOLDER"})
            send.assert_not_called()

    def test_malformed_event_does_not_block_or_expose_content(self):
        for value in ("PRIVATE not JSON", "[]", "x" * 1048577):
            text = self.invoke(value)
            self.assertIn("notification skipped", text)
            self.assertNotIn("PRIVATE", text)

    def test_failure_does_not_print_secret_exception(self):
        with patch.object(notifier, "send", side_effect=OSError("PRIVATE_URL")):
            text = self.invoke({"hookName": "agent_error"}, {"CLINE_NOTIFY_WEBHOOK_URL": "PRIVATE_URL"})
            self.assertIn("notification skipped", text)
            self.assertNotIn("PRIVATE_URL", text)

    def test_endpoint_validation(self):
        payload = notifier.notification({"hookName": "agent_end"})
        for url in ("file:///tmp/data", "https://example.com/", "https://user:pass@example.com/api/webhook/id",
                    "https://example.com/api/webhook/", "https://example.com/api/webhook/id?secret=value"):
            with self.assertRaises(ValueError):
                notifier.send(payload, url)

    def test_real_json_post_and_refused_redirect(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.path, self.headers["Content-Type"],
                                 json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(302 if self.path.endswith("redirect") else 200)
                self.send_header("Location", "/SHOULD_NOT_FOLLOW")
                self.end_headers()
            def log_message(self, *args):
                pass
        with HTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/api/webhook/"
            payload = notifier.notification({"hookName": "agent_end"})
            try:
                notifier.send(payload, url + "test")
                self.assertEqual(received[0], ("/api/webhook/test", "application/json", payload))
                with self.assertRaises(Exception):
                    notifier.send(payload, url + "redirect")
                self.assertEqual(len(received), 2)
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()

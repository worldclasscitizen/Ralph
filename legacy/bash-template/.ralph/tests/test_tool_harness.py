from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


RALPH_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = RALPH_DIR.parent
sys.path.insert(0, str(RALPH_DIR))

from tool_harness.bridge import run_glm_coding_plan_bridge
from tool_harness.config import ModelRuntime
from tool_harness.providers import ApiError, ChatCompletionsProvider
from tool_harness.runner import run_direct_agent
from tool_harness.tools import ToolPolicyError, WorkspaceTools


def test_policy() -> dict:
    return {
        "maxModelTurns": 8,
        "maxToolCalls": 20,
        "maxReadBytes": 262144,
        "maxWriteBytes": 2097152,
        "maxToolOutputBytes": 65536,
        "requestTimeoutSeconds": 10,
        "verifierTimeoutSeconds": 10,
        "maxPolicyViolations": 2,
        "protectedPaths": [
            ".git",
            ".git/**",
            ".env",
            ".antigravity/**",
            ".ralph/**",
            ".claude/**",
            "**/*.pem",
            "**/*.key",
        ],
        "verifier": {"id": "project", "argv": ["verify.sh"]},
    }


def initialize_repo(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    verifier = root / "verify.sh"
    verifier.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    verifier.chmod(verifier.stat().st_mode | stat.S_IXUSR)
    subprocess.run(["git", "add", "verify.sh"], cwd=root, check=True)


class ScriptedProvider:
    def __init__(self) -> None:
        self.turn = 0

    def complete(self, messages, tools):
        self.turn += 1
        if self.turn == 1:
            return {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "read before edit",
                    "tool_calls": [
                        {
                            "id": "read-1",
                            "type": "function",
                            "function": {"name": "read_file", "arguments": '{"path":"sample.txt"}'},
                        }
                    ],
                },
                "usage": {},
                "request_id": "one",
            }
        if self.turn == 2:
            assistant = next(message for message in messages if message.get("role") == "assistant")
            if assistant.get("reasoning_content") != "read before edit":
                raise AssertionError("reasoning_content was not preserved")
            tool_result = json.loads(messages[-1]["content"])
            digest = tool_result["result"]["sha256"]
            return {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "apply exact edit",
                    "tool_calls": [
                        {
                            "id": "edit-1",
                            "type": "function",
                            "function": {
                                "name": "edit_file",
                                "arguments": {
                                    "path": "sample.txt",
                                    "expected_sha256": digest,
                                    "edits": [
                                        {
                                            "old_text": "before",
                                            "new_text": "after",
                                            "expected_occurrences": 1,
                                        }
                                    ],
                                },
                            },
                        }
                    ],
                },
                "usage": {},
                "request_id": "two",
            }
        return {
            "message": {"role": "assistant", "content": "edited and verified", "tool_calls": None},
            "usage": {},
            "request_id": "three",
        }


class ToolHarnessTests(unittest.TestCase):
    def test_workspace_edit_and_rollback_are_sha_safe(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_repo(root)
            sample = root / "sample.txt"
            sample.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "add", "sample.txt"], cwd=root, check=True)
            run_dir = root / ".ralph" / "runs" / "test"
            tools = WorkspaceTools(root, test_policy(), run_dir)
            read = tools.read_file("sample.txt")
            tools.edit_file(
                "sample.txt",
                read["sha256"],
                [{"old_text": "before", "new_text": "after", "expected_occurrences": 1}],
            )
            self.assertEqual(sample.read_text(encoding="utf-8"), "after\n")
            tools.rollback()
            self.assertEqual(sample.read_text(encoding="utf-8"), "before\n")

    def test_workspace_rejects_secret_and_parent_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_repo(root)
            (root / ".env").write_text("SECRET=value\n", encoding="utf-8")
            tools = WorkspaceTools(root, test_policy(), root / ".ralph" / "runs" / "test")
            with self.assertRaises(ToolPolicyError):
                tools.read_file(".env")
            with self.assertRaises(ToolPolicyError):
                tools.read_file("../outside.txt")

    def test_direct_agent_preserves_reasoning_and_edits(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_repo(root)
            (root / "sample.txt").write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "add", "sample.txt"], cwd=root, check=True)
            output = run_direct_agent(
                provider=ScriptedProvider(),
                project_root=root,
                prompt="change sample",
                policy=test_policy(),
                run_dir=root / ".ralph" / "runs" / "test",
                mode="run",
                event_callback=lambda *_: None,
            )
            self.assertEqual(output, "edited and verified")
            self.assertEqual((root / "sample.txt").read_text(encoding="utf-8"), "after\n")

    def test_http_429_is_typed_for_outer_fallback(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(429)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"quota reached"}}')

            def log_message(self, *_):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            provider = ChatCompletionsProvider(
                provider="deepseek",
                base_url=f"http://127.0.0.1:{server.server_port}",
                api_key="test-only",
                model_id="fake-model",
                reasoning_effort="high",
                timeout_seconds=2,
            )
            with self.assertRaises(ApiError) as caught:
                provider.complete([{"role": "user", "content": "test"}], [])
            self.assertEqual(caught.exception.error_class, "rate_limit")
            self.assertEqual(caught.exception.http_status, 429)
        finally:
            server.shutdown()
            server.server_close()

    def test_tool_agent_cli_resolves_model_and_uses_fake_endpoint(self) -> None:
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length))
                requests.append(payload)
                body = json.dumps(
                    {
                        "id": "fake-response",
                        "choices": [{"message": {"role": "assistant", "content": "CLI_SMOKE_OK"}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                    }
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as run_name:
                # 개인 config.local.json에 deepseek-pro가 없어도 통과하도록 테스트 전용 설정을 쓴다.
                local_config = Path(run_name) / "config.local.json"
                local_config.write_text(
                    json.dumps(
                        {
                            "$schema": "./config.local.schema.json",
                            "schemaVersion": "3.0",
                            "kind": "ralph-orchestration-local-config",
                            "spec": "./config.json",
                            "ownerLabel": "test-only",
                            "providers": {
                                "deepseek": {
                                    "catalogProvider": "deepseek",
                                    "enabled": True,
                                    "connection": {
                                        "mode": "api",
                                        "baseUrlEnv": "DEEPSEEK_BASE_URL",
                                        "apiKeyEnv": "DEEPSEEK_API_KEY",
                                    },
                                }
                            },
                            "models": {"deepseek-pro": {"catalogModel": "deepseek-pro", "reasoningEffort": "max"}},
                            "taskPipelines": {
                                task: ["deepseek-pro"]
                                for task in (
                                    "planning_architecture",
                                    "frontend_visual",
                                    "backend_core",
                                    "tdd_debugging",
                                    "static_review",
                                    "delivery_evidence",
                                )
                            },
                            "ralph": {
                                "fallbackChains": {"critic": ["deepseek-pro"], "metaPrompter": ["deepseek-pro"]},
                                "defaults": {"task": "backend_core", "maxIterations": 1, "minimumCriticScore": 85},
                            },
                        }
                    ),
                    encoding="utf-8",
                )
                env = os.environ.copy()
                env.update(
                    {
                        "DEEPSEEK_API_KEY": "test-only",
                        "DEEPSEEK_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                        "RALPH_RUN_DIR": run_name,
                        "RALPH_LOCAL_CONFIG": str(local_config),
                    }
                )
                completed = subprocess.run(
                    [sys.executable, str(RALPH_DIR / "tool-agent.py"), "--model-alias", "deepseek-pro", "--mode", "smoke"],
                    input="reply with a marker",
                    text=True,
                    capture_output=True,
                    cwd=PROJECT_ROOT,
                    env=env,
                    check=True,
                )
            self.assertEqual(completed.stdout.strip(), "CLI_SMOKE_OK")
            self.assertEqual(requests[0]["model"], "deepseek-v4-pro")
            self.assertEqual(requests[0]["reasoning_effort"], "max")
            self.assertNotIn("tools", requests[0])
        finally:
            server.shutdown()
            server.server_close()

    def test_glm_coding_bridge_commits_only_mirror_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name) / "repo"
            root.mkdir()
            initialize_repo(root)
            sample = root / "sample.txt"
            sample.write_text("before\n", encoding="utf-8")
            subprocess.run(["git", "add", "sample.txt"], cwd=root, check=True)
            fake = Path(temp_name) / "fake-claude.py"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys\n"
                "assert os.environ.get('ANTHROPIC_AUTH_TOKEN') == 'coding-plan-test-key'\n"
                "assert os.environ.get('ANTHROPIC_BASE_URL') == 'https://api.z.ai/api/anthropic'\n"
                "pathlib.Path('sample.txt').write_text('after\\n', encoding='utf-8')\n"
                "sys.stdin.read()\n"
                "print('{\"result\":\"GLM bridge complete\",\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"total_tokens\":18}}')\n",
                encoding="utf-8",
            )
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            runtime = ModelRuntime(
                alias="glm-5-3",
                provider="zai-coding-plan",
                model_id="glm-5.3",
                reasoning_effort="max",
                connection={"apiKeyEnv": "GLM_API_KEY"},
                policy=test_policy(),
            )
            old = os.environ.get("RALPH_CLAUDE_BIN")
            os.environ["RALPH_CLAUDE_BIN"] = str(fake)
            try:
                output = run_glm_coding_plan_bridge(
                    project_root=root,
                    runtime=runtime,
                    prompt="change sample",
                    mode="run",
                    dotenv={"GLM_API_KEY": "coding-plan-test-key"},
                    run_dir=root / ".ralph" / "runs" / "bridge",
                    event_callback=lambda *_: None,
                )
            finally:
                if old is None:
                    os.environ.pop("RALPH_CLAUDE_BIN", None)
                else:
                    os.environ["RALPH_CLAUDE_BIN"] = old
            self.assertEqual(output, "GLM bridge complete")
            self.assertEqual(sample.read_text(encoding="utf-8"), "after\n")

    def test_claude_builtin_wrapper_uses_saved_login_not_api_env(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            fake = Path(temp_name) / "fake-claude.py"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "if 'auth' in sys.argv and 'status' in sys.argv:\n"
                "    print(json.dumps({'loggedIn': True, 'authMethod': 'claude.ai', 'apiProvider': 'firstParty', 'subscriptionType': 'pro'}))\n"
                "    raise SystemExit(0)\n"
                "assert 'ANTHROPIC_API_KEY' not in os.environ\n"
                "assert 'ANTHROPIC_AUTH_TOKEN' not in os.environ\n"
                "assert 'ANTHROPIC_BASE_URL' not in os.environ\n"
                "assert 'ANTHROPIC_DEFAULT_OPUS_MODEL' not in os.environ\n"
                "assert '--model' in sys.argv and 'claude-opus-4-6' in sys.argv\n"
                "assert '--effort' in sys.argv and 'max' in sys.argv\n"
                "sys.stdin.read()\n"
                "print(json.dumps({'result':'CLAUDE_BUILTIN_OK','usage':{'input_tokens':21,'output_tokens':8,'total_tokens':29}}))\n",
                encoding="utf-8",
            )
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            env = os.environ.copy()
            env.update(
                {
                    "RALPH_CLAUDE_BIN": str(fake),
                    "ANTHROPIC_API_KEY": "must-be-removed",
                    "ANTHROPIC_AUTH_TOKEN": "must-be-removed",
                    "ANTHROPIC_BASE_URL": "https://must-be-removed.invalid",
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-must-be-removed",
                    "RALPH_RUN_DIR": str(Path(temp_name) / "run"),
                    "RALPH_MODEL_ALIAS": "claude-opus",
                    "RALPH_ITERATION": "1",
                    "RALPH_ATTEMPT": "1",
                }
            )
            completed = subprocess.run(
                [str(RALPH_DIR / "claude-builtin-agent.sh"), "claude-opus-4-6", "max", "plan"],
                input="smoke",
                text=True,
                capture_output=True,
                env=env,
                cwd=PROJECT_ROOT,
                check=True,
            )
            self.assertEqual(completed.stdout.strip(), "CLAUDE_BUILTIN_OK")
            usage = json.loads((Path(temp_name) / "run" / "usage-events.jsonl").read_text(encoding="utf-8"))
            self.assertEqual(usage["inputTokens"], 21)
            self.assertEqual(usage["outputTokens"], 8)
            self.assertEqual(usage["modelAlias"], "claude-opus")

    def test_codex_builtin_wrapper_preserves_answer_and_records_usage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            fake = Path(temp_name) / "fake-codex.py"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                "assert 'exec' in sys.argv and '--json' in sys.argv\n"
                "target = pathlib.Path(sys.argv[sys.argv.index('--output-last-message') + 1])\n"
                "sys.stdin.read()\n"
                "target.write_text('CODEX_BUILTIN_OK\\n', encoding='utf-8')\n"
                "print(json.dumps({'type':'turn.completed','usage':{'input_tokens':31,'cached_input_tokens':4,'output_tokens':9,'reasoning_output_tokens':3,'total_tokens':40}}))\n",
                encoding="utf-8",
            )
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            run_dir = Path(temp_name) / "run"
            env = os.environ.copy()
            env.update(
                {
                    "RALPH_CODEX_BIN": str(fake),
                    "RALPH_RUN_DIR": str(run_dir),
                    "RALPH_MODEL_ALIAS": "openai-sol",
                    "RALPH_ITERATION": "2",
                    "RALPH_ATTEMPT": "1",
                    "RALPH_STAGE": "Worker",
                }
            )
            completed = subprocess.run(
                [str(RALPH_DIR / "codex-builtin-agent.sh"), "gpt-5.6-sol", "xhigh", "read-only"],
                input="smoke",
                text=True,
                capture_output=True,
                env=env,
                cwd=PROJECT_ROOT,
                check=True,
            )
            self.assertEqual(completed.stdout.strip(), "CODEX_BUILTIN_OK")
            usage = json.loads((run_dir / "usage-events.jsonl").read_text(encoding="utf-8"))
            self.assertEqual(usage["inputTokens"], 31)
            self.assertEqual(usage["outputTokens"], 9)
            self.assertEqual(usage["totalTokens"], 40)


if __name__ == "__main__":
    unittest.main()

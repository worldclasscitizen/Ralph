from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path


RALPH_DIR = Path(__file__).resolve().parents[1]
SERVER_PATH = RALPH_DIR / "dashboard" / "server.py"
SPEC = importlib.util.spec_from_file_location("ralph_dashboard_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("dashboard server module을 불러올 수 없습니다.")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


def initialize_project(root: Path) -> None:
    (root / ".ralph" / "runs").mkdir(parents=True)
    (root / ".ralph" / "PROMPT.md").write_text(
        """# 작업

## 구현 요구사항

1. 로그인 화면을 만든다.
2. 오류 상태를 검증한다.

## 완료 조건

- [ ] 단위 테스트 통과
- [x] 화면 명세 작성
""",
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "add", ".ralph/PROMPT.md"], cwd=root, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Ralph Test",
            "-c",
            "user.email=ralph@example.invalid",
            "commit",
            "-qm",
            "test baseline",
        ],
        cwd=root,
        check=True,
    )


class DashboardRepositoryTests(unittest.TestCase):
    def test_compact_summary_layout_preserves_primary_metadata(self) -> None:
        css = (RALPH_DIR / "dashboard" / "static" / "styles.css").read_text(encoding="utf-8")
        app = (RALPH_DIR / "dashboard" / "static" / "app.js").read_text(encoding="utf-8")
        overview_rule = css.split(".overview-facts strong {", 1)[1].split("}", 1)[0]

        self.assertIn("repeat(auto-fit, minmax(164px, 1fr))", css)
        self.assertIn("overflow: visible", overview_rule)
        self.assertIn("white-space: nowrap", overview_rule)
        self.assertNotIn("text-overflow: ellipsis", overview_rule)
        self.assertIn('secondary.className = "run-secondary"', app)

    def test_prompt_tasks_keep_explicit_completion(self) -> None:
        tasks = SERVER.parse_prompt_tasks(
            """## 구현 요구사항
1. API를 만든다.
2. UI를 만든다.
## 완료 조건
- [x] 테스트 통과
- [ ] 캡처 생성
"""
        )
        self.assertEqual([task["status"] for task in tasks], ["pending", "pending", "completed", "pending"])
        self.assertEqual(tasks[-1]["text"], "캡처 생성")

    def test_snapshot_reduces_stage_events_and_live_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            run_dir = root / ".ralph" / "runs" / "run-1"
            run_dir.mkdir()
            (run_dir / "run.json").write_text(
                json.dumps(
                    {
                        "runId": "run-1",
                        "task": "frontend_visual",
                        "startedAt": "2026-08-29T00:00:00Z",
                        "branch": "test",
                        "baselineCommit": "abc",
                        "maxIterations": 6,
                        "minimumCriticScore": 85,
                    }
                ),
                encoding="utf-8",
            )
            events = [
                {
                    "id": "1",
                    "timestamp": "2026-08-29T00:00:01Z",
                    "type": "iteration_started",
                    "runId": "run-1",
                    "task": "frontend_visual",
                    "iteration": 1,
                    "stage": "iteration",
                    "status": "running",
                    "summary": "iteration started",
                },
                {
                    "id": "2",
                    "timestamp": "2026-08-29T00:00:02Z",
                    "type": "stage_completed",
                    "runId": "run-1",
                    "task": "frontend_visual",
                    "iteration": 1,
                    "stage": "pre_critic",
                    "status": "completed",
                    "modelAlias": "gemini-flash",
                    "summary": "평가 완료",
                    "artifact": "critic-pre-1.json",
                },
                {
                    "id": "3",
                    "timestamp": "2026-08-29T00:00:03Z",
                    "type": "model_attempt_started",
                    "runId": "run-1",
                    "task": "frontend_visual",
                    "iteration": 1,
                    "stage": "Worker",
                    "status": "running",
                    "modelAlias": "gemini-flash",
                    "attempt": 1,
                    "summary": "worker running",
                    "artifact": "worker-1.output.md.gemini-flash.attempt-1",
                },
            ]
            (run_dir / "events.jsonl").write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
            )
            (run_dir / "critic-pre-1.json").write_text('{"summary":"ok"}\n', encoding="utf-8")
            (run_dir / "worker-1.output.md.gemini-flash.attempt-1").write_text("streaming output\n", encoding="utf-8")
            (root / ".ralph" / ".lock").mkdir()

            repository = SERVER.RalphRepository(root)
            snapshot = repository.build_snapshot("run-1", bypass_cache=True)
            self.assertTrue(snapshot["active"])
            self.assertEqual(snapshot["iterations"][0]["stages"][0]["status"], "completed")
            worker = next(stage for stage in snapshot["iterations"][0]["stages"] if stage["id"] == "worker")
            self.assertEqual(worker["status"], "running")
            self.assertIn("streaming output", snapshot["liveArtifact"]["content"])

    def test_stage_status_uses_latest_recovered_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            events = [
                {"iteration": 1, "stage": "Worker", "type": "model_attempt_failed", "status": "failed"},
                {"iteration": 1, "stage": "Worker", "type": "fallback", "status": "fallback_next_model"},
                {"iteration": 1, "stage": "worker", "type": "stage_completed", "status": "completed"},
            ]
            worker = next(stage for stage in repository._stage_snapshot(1, events) if stage["id"] == "worker")
            self.assertEqual(worker["status"], "completed")

    def test_interrupted_running_node_becomes_failed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            events = [
                {"iteration": 1, "stage": "Pre-Critic", "type": "stage_completed", "status": "completed"},
                {"iteration": 1, "stage": "Worker", "type": "model_attempt_started", "status": "running"},
            ]
            stages = repository._stage_snapshot(1, events, active=False, run_status="interrupted")
            worker = next(stage for stage in stages if stage["id"] == "worker")
            self.assertEqual(worker["status"], "failed")
            self.assertIn("중단", worker["summary"])

    def test_recovery_checkpoint_does_not_mark_iteration_complete(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            events = [
                {"iteration": 1, "stage": "Pre-Critic", "type": "stage_completed", "status": "completed"},
                {"iteration": 1, "stage": "Meta-Prompter", "type": "model_attempt_completed", "status": "completed"},
                {"iteration": 1, "stage": "checkpoint", "type": "checkpoint_completed", "status": "warning"},
            ]
            checkpoint = {"status": "meta_invalid", "commit": "abc123"}
            stages = repository._stage_snapshot(
                1,
                events,
                active=False,
                run_status="meta_invalid",
                checkpoint=checkpoint,
            )
            meta = next(stage for stage in stages if stage["id"] == "meta_prompter")
            git_stage = next(stage for stage in stages if stage["id"] == "checkpoint")
            self.assertEqual(meta["status"], "failed")
            self.assertIn("형식을 충족하지 못해", meta["summary"])
            self.assertEqual(git_stage["status"], "warning")
            self.assertIn("Iteration 완료를 뜻하지 않습니다", git_stage["summary"])

    def test_success_none_exit_zero_is_explained_as_normal_completion(self) -> None:
        message = SERVER.humanize_fallback_event(
            {
                "type": "fallback",
                "status": "success",
                "summary": "success: none (exit 0)",
            }
        )
        self.assertIn("정상 종료", message)
        self.assertIn("장애 없음", message)
        self.assertIn("종료 코드 0", message)

    def test_post_critic_fail_is_not_shown_as_passed_stage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            events = [
                {
                    "iteration": 1,
                    "stage": "Post-Critic",
                    "type": "stage_completed",
                    "status": "completed",
                    "score": 65,
                    "verdict": "fail",
                    "summary": "평가 완료",
                }
            ]
            post_critic = next(
                stage for stage in repository._stage_snapshot(1, events, active=False, run_status="interrupted")
                if stage["id"] == "post_critic"
            )
            self.assertEqual(post_critic["status"], "failed")
            self.assertIn("65점", post_critic["summary"])
            self.assertIn("통과 판정을 받지 못했습니다", post_critic["summary"])

    def test_legacy_checkpoint_failure_does_not_claim_missing_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            checkpoint = next(
                stage for stage in repository._stage_snapshot(1, [], active=False, run_status="checkpoint_failed")
                if stage["id"] == "checkpoint"
            )
            self.assertEqual(checkpoint["status"], "failed")
            self.assertEqual(checkpoint["artifact"], "")
            self.assertIn("정확한 Git 실패 원인이 남아 있지 않습니다", checkpoint["summary"])
            self.assertEqual(checkpoint["executorLabel"], "Git 안전 스크립트")

    def test_checkpoint_failure_uses_recorded_error_event_and_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            events = [
                {
                    "iteration": 1,
                    "stage": "checkpoint",
                    "type": "checkpoint_failed",
                    "status": "failed",
                    "summary": "민감 파일이 감지되어 Git checkpoint 생성을 중단했습니다.",
                    "artifact": "git-checkpoint-1.stderr",
                }
            ]
            checkpoint = next(
                stage for stage in repository._stage_snapshot(
                    1,
                    events,
                    active=False,
                    run_status="checkpoint_failed",
                    checkpoint={"_errorArtifact": "git-checkpoint-1.stderr"},
                )
                if stage["id"] == "checkpoint"
            )
            self.assertEqual(checkpoint["artifact"], "git-checkpoint-1.stderr")
            self.assertIn("민감 파일", checkpoint["summary"])

    def test_usage_snapshot_combines_exact_and_legacy_total_without_guessing_split(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            run_dir = root / ".ralph" / "runs" / "run-usage"
            run_dir.mkdir()
            metadata = {
                "route": {
                    "models": [
                        {
                            "alias": "openai-sol",
                            "provider": "openai",
                            "modelId": "gpt-5.6-sol",
                            "reasoning": {"value": "xhigh"},
                        }
                    ]
                }
            }
            events = [
                {"timestamp": "2026-08-29T00:00:01Z", "iteration": 1, "stage": "Pre-Critic", "type": "model_attempt_started", "status": "running", "modelAlias": "openai-sol", "attempt": 1},
                {"timestamp": "2026-08-29T00:00:02Z", "iteration": 1, "stage": "Pre-Critic", "type": "model_attempt_completed", "status": "completed", "modelAlias": "openai-sol", "attempt": 1, "artifact": "critic.raw"},
                {"timestamp": "2026-08-29T00:00:03Z", "iteration": 1, "stage": "Worker", "type": "model_attempt_started", "status": "running", "modelAlias": "openai-sol", "attempt": 1},
                {"timestamp": "2026-08-29T00:00:04Z", "iteration": 1, "stage": "Worker", "type": "model_attempt_completed", "status": "completed", "modelAlias": "openai-sol", "attempt": 1, "artifact": "worker.out"},
            ]
            (run_dir / "usage-events.jsonl").write_text(
                json.dumps(
                    {
                        "iteration": 1,
                        "stage": "Pre-Critic",
                        "modelAlias": "openai-sol",
                        "attempt": 1,
                        "inputTokens": 100,
                        "outputTokens": 20,
                        "totalTokens": 120,
                        "source": "test",
                    }
                ) + "\n",
                encoding="utf-8",
            )
            (run_dir / "worker.out.stderr").write_text("tokens used\n1,500\n", encoding="utf-8")
            repository = SERVER.RalphRepository(root)
            catalog = repository._model_catalog(metadata)
            usage = repository._usage_snapshot(run_dir, metadata, events, catalog)
            self.assertEqual(usage["totals"]["totalTokens"], 1620)
            self.assertEqual(usage["totals"]["inputTokens"], 100)
            self.assertEqual(usage["totals"]["outputTokens"], 20)
            self.assertEqual([call["tokenDetail"] for call in usage["calls"]], ["exact", "total_only"])
            self.assertEqual(usage["models"][0]["model"]["displayLabel"], "GPT 5.6 Sol · Extra High")
            self.assertIn("계측 도입 전 CLI 로그", usage["note"])
            self.assertIn("임의로 추정하지 않습니다", usage["note"])

    def test_artifact_path_is_confined_and_secret_is_redacted(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            run_dir = root / ".ralph" / "runs" / "run-2"
            run_dir.mkdir()
            (run_dir / "verify-1.log").write_text("api_key=secret-value-123\n", encoding="utf-8")
            repository = SERVER.RalphRepository(root)
            self.assertIsNone(repository.safe_artifact("run-2", "../../.git/config"))
            payload = repository.artifact_payload("run-2", "verify-1.log")
            self.assertIsNotNone(payload)
            self.assertIn("[REDACTED]", payload["content"])
            self.assertNotIn("secret-value-123", payload["content"])

    def test_git_summary_preserves_porcelain_status_columns(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            prompt = root / ".ralph" / "PROMPT.md"
            prompt.write_text(prompt.read_text(encoding="utf-8") + "\n변경\n", encoding="utf-8")
            (root / "new-file.txt").write_text("new\n", encoding="utf-8")
            status = SERVER.RalphRepository(root).git_summary()["status"]
            self.assertIn(" M .ralph/PROMPT.md", status)
            self.assertIn("?? new-file.txt", status)

    def test_operator_note_write_is_atomic_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            repository.write_operator_note("현재 타입 오류만 해결해줘.")
            note = (root / ".ralph" / "OPERATOR_NOTE.local.md").read_text(encoding="utf-8")
            self.assertIn("현재 타입 오류만", note)
            with self.assertRaises(ValueError):
                repository.write_operator_note("x" * 5000)

    def test_delete_run_removes_only_local_evidence_and_stale_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            run_dir = root / ".ralph" / "runs" / "run-delete"
            run_dir.mkdir()
            (run_dir / "run.json").write_text('{"runId":"run-delete"}\n', encoding="utf-8")
            (run_dir / "verify-1.log").write_text("ok\n", encoding="utf-8")
            (root / ".ralph" / "state.json").write_text(
                json.dumps({"runId": "run-delete", "runDirectory": str(run_dir), "status": "passed"}),
                encoding="utf-8",
            )
            head_before = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
            ).stdout.strip()
            result = SERVER.RalphRepository(root).delete_run("run-delete")
            self.assertTrue(result["ok"])
            self.assertFalse(run_dir.exists())
            self.assertFalse((root / ".ralph" / "state.json").exists())
            head_after = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
            ).stdout.strip()
            self.assertEqual(head_before, head_after)

    def test_delete_run_rejects_active_latest_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            run_dir = root / ".ralph" / "runs" / "run-active"
            run_dir.mkdir()
            (run_dir / "run.json").write_text('{"runId":"run-active"}\n', encoding="utf-8")
            (root / ".ralph" / ".lock").mkdir()
            with self.assertRaises(RuntimeError):
                SERVER.RalphRepository(root).delete_run("run-active")
            self.assertTrue(run_dir.exists())

    def test_delete_runs_removes_multiple_histories_in_one_request(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            for run_id in ("run-one", "run-two"):
                run_dir = root / ".ralph" / "runs" / run_id
                run_dir.mkdir()
                (run_dir / "run.json").write_text(json.dumps({"runId": run_id}) + "\n", encoding="utf-8")
                (run_dir / "evidence.log").write_text("evidence\n", encoding="utf-8")

            result = SERVER.RalphRepository(root).delete_runs(["run-one", "run-two", "run-one"])

            self.assertEqual(result["deletedRuns"], 2)
            self.assertEqual(result["runIds"], ["run-one", "run-two"])
            self.assertFalse((root / ".ralph" / "runs" / "run-one").exists())
            self.assertFalse((root / ".ralph" / "runs" / "run-two").exists())

    def test_delete_runs_validates_entire_batch_before_removing_any_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            archived = root / ".ralph" / "runs" / "run-archived"
            active = root / ".ralph" / "runs" / "run-active"
            archived.mkdir()
            active.mkdir()
            (archived / "run.json").write_text('{"runId":"run-archived"}\n', encoding="utf-8")
            (active / "run.json").write_text('{"runId":"run-active"}\n', encoding="utf-8")
            os.utime(active, (active.stat().st_atime, archived.stat().st_mtime + 1))
            (root / ".ralph" / ".lock").mkdir()

            with self.assertRaises(RuntimeError):
                SERVER.RalphRepository(root).delete_runs(["run-archived", "run-active"])

            self.assertTrue(archived.exists())
            self.assertTrue(active.exists())


class DashboardHttpTests(unittest.TestCase):
    def test_health_and_snapshot_endpoints_are_local(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            repository = SERVER.RalphRepository(root)
            httpd = SERVER.RalphDashboardServer(("127.0.0.1", 0), repository)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{httpd.server_port}"
                with urllib.request.urlopen(base + "/api/health", timeout=2) as response:
                    health = json.loads(response.read())
                self.assertTrue(health["ok"])
                with urllib.request.urlopen(base + "/api/snapshot", timeout=2) as response:
                    snapshot = json.loads(response.read())
                self.assertEqual(snapshot["projectRoot"], str(root.resolve()))
                self.assertGreaterEqual(len(snapshot["tasks"]), 2)
            finally:
                httpd.shutdown()
                httpd.server_close()

    def test_delete_run_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            run_dir = root / ".ralph" / "runs" / "run-http-delete"
            run_dir.mkdir()
            (run_dir / "run.json").write_text('{"runId":"run-http-delete"}\n', encoding="utf-8")
            repository = SERVER.RalphRepository(root)
            httpd = SERVER.RalphDashboardServer(("127.0.0.1", 0), repository)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{httpd.server_port}/api/runs/run-http-delete", method="DELETE"
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    payload = json.loads(response.read())
                self.assertTrue(payload["ok"])
                self.assertFalse(run_dir.exists())
            finally:
                httpd.shutdown()
                httpd.server_close()

    def test_delete_runs_endpoint_accepts_multiple_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            initialize_project(root)
            for run_id in ("run-http-one", "run-http-two"):
                run_dir = root / ".ralph" / "runs" / run_id
                run_dir.mkdir()
                (run_dir / "run.json").write_text(json.dumps({"runId": run_id}) + "\n", encoding="utf-8")
            repository = SERVER.RalphRepository(root)
            httpd = SERVER.RalphDashboardServer(("127.0.0.1", 0), repository)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps({"runIds": ["run-http-one", "run-http-two"]}).encode("utf-8")
                request = urllib.request.Request(
                    f"http://127.0.0.1:{httpd.server_port}/api/runs",
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="DELETE",
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    payload = json.loads(response.read())
                self.assertEqual(payload["deletedRuns"], 2)
                self.assertFalse((root / ".ralph" / "runs" / "run-http-one").exists())
                self.assertFalse((root / ".ralph" / "runs" / "run-http-two").exists())
            finally:
                httpd.shutdown()
                httpd.server_close()


class ObservabilityShellTests(unittest.TestCase):
    def test_best_effort_event_is_valid_json(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            temp = Path(temp_name)
            events = temp / "events.jsonl"
            run_file = temp / "run.json"
            command = f"""
source {str(RALPH_DIR / 'observability.sh')!r}
ralph_observe_init {str(events)!r} {str(run_file)!r} run-test backend_core {str(temp)!r}
ralph_observe_event stage_started 2 worker running worker openai-sol 1 '구현 시작' worker-2.output.md
"""
            subprocess.run(["bash", "-c", command], check=True)
            payload = json.loads(events.read_text(encoding="utf-8"))
            self.assertEqual(payload["iteration"], 2)
            self.assertEqual(payload["stage"], "worker")
            self.assertEqual(payload["status"], "running")


if __name__ == "__main__":
    unittest.main()

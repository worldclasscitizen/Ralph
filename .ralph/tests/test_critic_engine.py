from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


RALPH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RALPH_DIR))
ENGINE_PATH = RALPH_DIR / "critic_engine.py"
SPEC = importlib.util.spec_from_file_location("ralph_critic_engine", ENGINE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("critic engine module을 불러올 수 없습니다.")
ENGINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENGINE)

CALIBRATION_PATH = RALPH_DIR / "critic_calibration.py"
CALIBRATION_SPEC = importlib.util.spec_from_file_location("ralph_critic_calibration", CALIBRATION_PATH)
if CALIBRATION_SPEC is None or CALIBRATION_SPEC.loader is None:
    raise RuntimeError("critic calibration module을 불러올 수 없습니다.")
CALIBRATION = importlib.util.module_from_spec(CALIBRATION_SPEC)
CALIBRATION_SPEC.loader.exec_module(CALIBRATION)


class CriticEngineTests(unittest.TestCase):
    def test_all_six_task_fixed_calibration_cases_match(self) -> None:
        report = CALIBRATION.run_calibration(
            RALPH_DIR / "evals" / "critic" / "calibration_cases.json", threshold=85, margin=5
        )
        self.assertTrue(report["ok"], report["mismatches"])
        self.assertEqual(report["totalCases"], 24)

    def test_criterion_ids_must_match_exactly(self) -> None:
        rubric = ENGINE.load_rubric(
            RALPH_DIR / "rubrics" / "base.json", RALPH_DIR / "rubrics" / "backend_core.json"
        )
        cases = ENGINE.load_json(RALPH_DIR / "evals" / "critic" / "calibration_cases.json")
        raw = CALIBRATION.raw_for_profile(rubric, cases["profiles"][0])
        raw["criteria"].pop()
        with self.assertRaises(ENGINE.CriticContractError):
            ENGINE.evaluate(raw, rubric, threshold=85, worker_exit=0, verifier_exit=0, stage="post-worker")

    def test_same_failure_twice_stops_for_operator(self) -> None:
        rubric = ENGINE.load_rubric(
            RALPH_DIR / "rubrics" / "base.json", RALPH_DIR / "rubrics" / "backend_core.json"
        )
        cases = ENGINE.load_json(RALPH_DIR / "evals" / "critic" / "calibration_cases.json")
        raw = CALIBRATION.raw_for_profile(rubric, cases["profiles"][2])
        assessment = ENGINE.evaluate(raw, rubric, threshold=85, worker_exit=0, verifier_exit=0, stage="post-worker")
        with tempfile.TemporaryDirectory() as temp_name:
            history = Path(temp_name) / "history.jsonl"
            history.write_text(json.dumps(assessment, ensure_ascii=False) + "\n", encoding="utf-8")
            guarded = ENGINE.apply_convergence_guard(assessment, history)
        self.assertEqual(guarded["decision"], "needs_operator")
        self.assertTrue(guarded["convergenceGuard"]["triggered"])

    def test_boundary_only_requests_second_critic_near_threshold(self) -> None:
        near = {"schemaValid": True, "score": 84, "threshold": 85, "hardGates": []}
        far = {"schemaValid": True, "score": 65, "threshold": 85, "hardGates": []}
        self.assertTrue(ENGINE.should_adjudicate(near, 5)[0])
        self.assertFalse(ENGINE.should_adjudicate(far, 5)[0])


if __name__ == "__main__":
    unittest.main()

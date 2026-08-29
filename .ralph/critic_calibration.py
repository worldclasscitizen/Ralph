#!/usr/bin/env python3
"""Run fixed Critic scoring fixtures without calling a paid model."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from critic_engine import evaluate, load_json, load_rubric, should_adjudicate


SCRIPT_DIR = Path(__file__).resolve().parent


def raw_for_profile(rubric: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    task_gate_ids = [item["id"] for item in rubric["hardGates"] if item["id"] not in {
        "worker_execution_failed", "deterministic_verifier_failed", "secret_or_user_data_exposure",
        "core_placeholder_claimed_complete", "tests_weakened", "destructive_out_of_scope_change",
    }]
    target_gate = task_gate_ids[0]
    criteria = [
        {
            "id": item["id"],
            "level": profile["criterionLevel"],
            "evidence": [f"fixture/{profile['id']}/{item['id']}"],
            "reason": "고정 평가 sample의 증거 수준입니다.",
        }
        for item in rubric["criteria"]
    ]
    hard_gates = [
        {
            "id": item["id"],
            "status": profile["taskGateStatus"] if item["id"] == target_gate else "pass",
            "evidence": [f"fixture/{profile['id']}/{item['id']}"],
            "reason": "고정 평가 sample의 Hard Gate 상태입니다.",
        }
        for item in rubric["hardGates"]
    ]
    findings = []
    if profile.get("finding"):
        finding = profile["finding"]
        findings.append(
            {
                "severity": finding["severity"],
                "criterionId": target_gate,
                "kind": finding["kind"],
                "actionableByWorker": finding["actionableByWorker"],
                "evidence": [f"fixture/{profile['id']}/{target_gate}"],
                "cause": "고정 sample의 차단 원인입니다.",
                "requiredChange": "sample이 요구하는 조치를 수행합니다.",
            }
        )
    return {"criteria": criteria, "hardGates": hard_gates, "findings": findings, "risks": [], "lesson": ""}


def run_calibration(cases_path: Path, threshold: int, margin: int) -> dict[str, Any]:
    cases = load_json(cases_path)
    results: list[dict[str, Any]] = []
    mismatches: list[dict[str, Any]] = []
    for task in cases["tasks"]:
        rubric = load_rubric(SCRIPT_DIR / "rubrics" / "base.json", SCRIPT_DIR / "rubrics" / f"{task}.json")
        for profile in cases["profiles"]:
            assessment = evaluate(
                raw_for_profile(rubric, profile), rubric, threshold=threshold,
                worker_exit=int(profile["workerExit"]), verifier_exit=int(profile["verifierExit"]), stage="post-worker",
            )
            boundary, _ = should_adjudicate(assessment, margin)
            result = {
                "task": task,
                "case": profile["id"],
                "score": assessment["score"],
                "decision": assessment["decision"],
                "boundaryAdjudication": boundary,
            }
            results.append(result)
            if assessment["decision"] != profile["expectedDecision"] or boundary != profile["expectedBoundaryAdjudication"]:
                mismatches.append({**result, "expectedDecision": profile["expectedDecision"], "expectedBoundaryAdjudication": profile["expectedBoundaryAdjudication"]})
    return {
        "ok": not mismatches,
        "threshold": threshold,
        "margin": margin,
        "totalCases": len(results),
        "passedCases": len(results) - len(mismatches),
        "mismatches": mismatches,
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Ralph Critic 고정 sample 보정")
    parser.add_argument("--cases", type=Path, default=SCRIPT_DIR / "evals" / "critic" / "calibration_cases.json")
    parser.add_argument("--threshold", type=int, default=85)
    parser.add_argument("--margin", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = run_calibration(args.cases, args.threshold, args.margin)
    body = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(body, encoding="utf-8")
    print(body, end="")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

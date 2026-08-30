#!/usr/bin/env python3
"""Deterministic scoring and convergence control for Ralph Critic output."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any


ALLOWED_LEVELS = {"absent", "partial", "verified", "complete"}
ALLOWED_GATE_STATUS = {"pass", "fail", "unknown"}
ALLOWED_SEVERITY = {"low", "medium", "high", "critical"}
ALLOWED_FINDING_KIND = {"code", "evidence", "environment", "scope_decision"}
OPERATOR_KINDS = {"environment", "scope_decision"}


class CriticContractError(ValueError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CriticContractError(f"JSON을 읽을 수 없습니다: {path.name}: {error}") from error
    if not isinstance(payload, dict):
        raise CriticContractError(f"JSON 객체가 필요합니다: {path.name}")
    return payload


def load_rubric(base_path: Path, task_path: Path) -> dict[str, Any]:
    base = load_json(base_path)
    task = load_json(task_path)
    criteria = [*base.get("criteria", []), *task.get("criteria", [])]
    hard_gates = [*base.get("hardGates", []), *task.get("hardGates", [])]
    anchors = base.get("anchors", {})
    if not isinstance(anchors, dict) or set(anchors) != ALLOWED_LEVELS:
        raise CriticContractError("base rubric의 anchors는 absent/partial/verified/complete를 모두 가져야 합니다.")
    if any(not isinstance(item, dict) for item in criteria + hard_gates):
        raise CriticContractError("rubric criteria와 hardGates는 객체 배열이어야 합니다.")
    criterion_ids = [str(item.get("id") or "") for item in criteria]
    gate_ids = [str(item.get("id") or "") for item in hard_gates]
    if "" in criterion_ids or len(criterion_ids) != len(set(criterion_ids)):
        raise CriticContractError("criterion id가 비었거나 중복됐습니다.")
    if "" in gate_ids or len(gate_ids) != len(set(gate_ids)):
        raise CriticContractError("hard gate id가 비었거나 중복됐습니다.")
    total_weight = sum(int(item.get("weight") or 0) for item in criteria)
    if total_weight != 100:
        raise CriticContractError(f"공통+작업별 criterion 배점 합은 100이어야 합니다: {total_weight}")
    return {
        "task": str(task.get("task") or task_path.stem),
        "name": str(task.get("name") or task_path.stem),
        "anchors": anchors,
        "criteria": criteria,
        "hardGates": hard_gates,
    }


def _string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise CriticContractError(f"{field}는 비어 있지 않은 문자열 배열이어야 합니다.")
    return [item.strip() for item in value]


def _index_exact(rows: Any, expected_ids: list[str], field: str) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list) or any(not isinstance(item, dict) for item in rows):
        raise CriticContractError(f"{field}는 객체 배열이어야 합니다.")
    indexed: dict[str, dict[str, Any]] = {}
    for item in rows:
        item_id = str(item.get("id") or "")
        if not item_id or item_id in indexed:
            raise CriticContractError(f"{field} id가 비었거나 중복됐습니다: {item_id or '(empty)'}")
        indexed[item_id] = item
    missing = sorted(set(expected_ids) - set(indexed))
    unknown = sorted(set(indexed) - set(expected_ids))
    if missing or unknown:
        raise CriticContractError(f"{field} id 불일치: missing={missing}, unknown={unknown}")
    return indexed


def _earned(weight: int, factor: float) -> int:
    return int((Decimal(weight) * Decimal(str(factor))).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _fingerprint(decision: str, criteria: list[dict[str, Any]], gates: list[dict[str, Any]], findings: list[dict[str, Any]]) -> str:
    payload = {
        "decision": decision,
        "gates": sorted(item["id"] for item in gates if item["status"] != "pass"),
        "findings": sorted(
            f"{item['criterionId']}:{item['kind']}:{item['severity']}:{item['cause']}"
            for item in findings
            if item["severity"] in {"high", "critical"}
        ),
        "lowCriteria": sorted(item["id"] for item in criteria if item["level"] in {"absent", "partial"}),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def evaluate(
    raw: dict[str, Any],
    rubric: dict[str, Any],
    *,
    threshold: int,
    worker_exit: int,
    verifier_exit: int,
    stage: str,
) -> dict[str, Any]:
    expected_criteria = [str(item["id"]) for item in rubric["criteria"]]
    expected_gates = [str(item["id"]) for item in rubric["hardGates"]]
    criterion_rows = _index_exact(raw.get("criteria"), expected_criteria, "criteria")
    gate_rows = _index_exact(raw.get("hardGates"), expected_gates, "hardGates")

    criteria: list[dict[str, Any]] = []
    for definition in rubric["criteria"]:
        criterion_id = str(definition["id"])
        source = criterion_rows[criterion_id]
        level = str(source.get("level") or "")
        if level not in ALLOWED_LEVELS:
            raise CriticContractError(f"criterion {criterion_id}의 level이 유효하지 않습니다: {level}")
        evidence = _string_list(source.get("evidence"), f"criteria.{criterion_id}.evidence")
        reason = str(source.get("reason") or "").strip()
        if not reason:
            raise CriticContractError(f"criterion {criterion_id}의 reason이 비었습니다.")
        weight = int(definition["weight"])
        factor = float(rubric["anchors"][level]["factor"])
        criteria.append(
            {
                "id": criterion_id,
                "label": str(definition.get("label") or criterion_id),
                "weight": weight,
                "level": level,
                "anchorLabel": str(rubric["anchors"][level].get("label") or level),
                "earned": _earned(weight, factor),
                "evidence": evidence,
                "reason": reason,
            }
        )

    hard_gates: list[dict[str, Any]] = []
    for definition in rubric["hardGates"]:
        gate_id = str(definition["id"])
        source = gate_rows[gate_id]
        status = str(source.get("status") or "")
        if status not in ALLOWED_GATE_STATUS:
            raise CriticContractError(f"hard gate {gate_id}의 status가 유효하지 않습니다: {status}")
        evidence = _string_list(source.get("evidence"), f"hardGates.{gate_id}.evidence")
        reason = str(source.get("reason") or "").strip()
        if not reason:
            raise CriticContractError(f"hard gate {gate_id}의 reason이 비었습니다.")
        if stage == "post-worker" and gate_id == "worker_execution_failed" and worker_exit != 0:
            status = "fail"
            evidence = [f"Worker exit code {worker_exit}", *evidence]
            reason = "Worker가 정상 종료하지 못했습니다."
        if stage == "post-worker" and gate_id == "deterministic_verifier_failed" and verifier_exit != 0:
            status = "fail"
            evidence = [f"Verifier exit code {verifier_exit}", *evidence]
            reason = "결정적 Verifier가 통과하지 못했습니다."
        hard_gates.append(
            {
                "id": gate_id,
                "label": str(definition.get("label") or gate_id),
                "status": status,
                "evidence": list(dict.fromkeys(evidence)),
                "reason": reason,
            }
        )

    raw_findings = raw.get("findings", [])
    if not isinstance(raw_findings, list) or any(not isinstance(item, dict) for item in raw_findings):
        raise CriticContractError("findings는 객체 배열이어야 합니다.")
    findings: list[dict[str, Any]] = []
    for index, source in enumerate(raw_findings):
        severity = str(source.get("severity") or "")
        criterion_id = str(source.get("criterionId") or "")
        kind = str(source.get("kind") or "")
        actionable = source.get("actionableByWorker")
        if severity not in ALLOWED_SEVERITY:
            raise CriticContractError(f"findings[{index}].severity가 유효하지 않습니다.")
        if criterion_id not in expected_criteria and criterion_id not in expected_gates:
            raise CriticContractError(f"findings[{index}].criterionId가 rubric에 없습니다: {criterion_id}")
        if kind not in ALLOWED_FINDING_KIND:
            raise CriticContractError(f"findings[{index}].kind가 유효하지 않습니다: {kind}")
        if not isinstance(actionable, bool):
            raise CriticContractError(f"findings[{index}].actionableByWorker는 boolean이어야 합니다.")
        evidence = _string_list(source.get("evidence"), f"findings[{index}].evidence")
        cause = str(source.get("cause") or "").strip()
        required_change = str(source.get("requiredChange") or "").strip()
        if not cause or not required_change:
            raise CriticContractError(f"findings[{index}]의 cause와 requiredChange가 필요합니다.")
        findings.append(
            {
                "severity": severity,
                "criterionId": criterion_id,
                "kind": kind,
                "actionableByWorker": actionable,
                "evidence": evidence,
                "cause": cause,
                "requiredChange": required_change,
            }
        )

    risks = _string_list(raw.get("risks", []), "risks") if raw.get("risks") else []
    lesson = str(raw.get("lesson") or "").strip()
    score = sum(item["earned"] for item in criteria)
    gate_failed = any(item["status"] == "fail" for item in hard_gates)
    gate_unknown = any(item["status"] == "unknown" for item in hard_gates)
    blocking_findings = [item for item in findings if item["severity"] in {"high", "critical"}]
    operator_blockers = [
        item for item in blocking_findings
        if not item["actionableByWorker"] and item["kind"] in OPERATOR_KINDS
    ]

    if gate_unknown or operator_blockers:
        decision = "needs_operator"
    elif worker_exit != 0 or verifier_exit != 0 or gate_failed or blocking_findings or score < threshold:
        decision = "retry"
    else:
        decision = "pass"

    if decision == "pass":
        summary = f"결정적 검증과 Hard Gate를 통과했고 작업별 점수가 {score}/{threshold}점입니다."
    elif decision == "needs_operator":
        summary = "환경·권한·범위 결정 또는 확인되지 않은 Hard Gate 때문에 사용자 확인이 필요합니다."
    else:
        summary = f"Worker가 해결할 수 있는 미충족 항목이 남아 있으며 작업별 점수가 {score}/{threshold}점입니다."

    failures = [
        {
            "severity": item["severity"],
            "criterion": item["criterionId"],
            "evidence": "; ".join(item["evidence"]),
            "cause": item["cause"],
            "required_change": item["requiredChange"],
            "kind": item["kind"],
            "actionableByWorker": item["actionableByWorker"],
        }
        for item in findings
    ]
    result = {
        "schemaVersion": 2,
        "schemaValid": True,
        "task": rubric["task"],
        "rubricName": rubric["name"],
        "stage": stage,
        "threshold": threshold,
        "decision": decision,
        "verdict": "pass" if decision == "pass" else "fail",
        "score": score,
        "summary": summary,
        "criteria": criteria,
        "hardGates": hard_gates,
        "findings": findings,
        "failures": failures,
        "risks": risks,
        "lesson": lesson,
    }
    result["fingerprint"] = _fingerprint(decision, criteria, hard_gates, findings)
    return result


def invalid_assessment(task: str, stage: str, threshold: int, message: str) -> dict[str, Any]:
    result = {
        "schemaVersion": 2,
        "schemaValid": False,
        "task": task,
        "stage": stage,
        "threshold": threshold,
        "decision": "needs_operator",
        "verdict": "fail",
        "score": 0,
        "summary": "Critic 출력 계약을 검증할 수 없어 자동 판정을 중단합니다.",
        "criteria": [],
        "hardGates": [],
        "findings": [
            {
                "severity": "high",
                "criterionId": "critic_output_contract",
                "kind": "environment",
                "actionableByWorker": False,
                "evidence": [message],
                "cause": "Critic이 작업별 평가 스키마를 지키지 않았습니다.",
                "requiredChange": "Critic 모델 또는 출력 어댑터를 점검한 뒤 다시 실행합니다.",
            }
        ],
        "failures": [
            {
                "severity": "high",
                "criterion": "critic_output_contract",
                "evidence": message,
                "cause": "Critic이 작업별 평가 스키마를 지키지 않았습니다.",
                "required_change": "Critic 모델 또는 출력 어댑터를 점검한 뒤 다시 실행합니다.",
                "kind": "environment",
                "actionableByWorker": False,
            }
        ],
        "risks": ["잘못된 Critic 결과로 Worker 반복을 계속하면 비용만 증가할 수 있습니다."],
        "lesson": "Critic 출력 계약이 유효하지 않으면 Worker 반복 대신 사용자 확인 상태로 중단합니다.",
    }
    result["fingerprint"] = hashlib.sha256(message.encode("utf-8")).hexdigest()[:16]
    return result


def apply_convergence_guard(current: dict[str, Any], history_path: Path | None, min_improvement: int = 3) -> dict[str, Any]:
    if current.get("decision") != "retry" or history_path is None or not history_path.is_file():
        return current
    history: list[dict[str, Any]] = []
    for line in history_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            history.append(row)
    reason = ""
    if history and history[-1].get("decision") == "retry" and history[-1].get("fingerprint") == current.get("fingerprint"):
        reason = "동일한 차단 원인이 두 이터레이션 연속 반복됐습니다."
    elif len(history) >= 2 and all(item.get("decision") == "retry" for item in history[-2:]):
        previous_two = history[-2:]
        first_gain = int(previous_two[1].get("score") or 0) - int(previous_two[0].get("score") or 0)
        second_gain = int(current.get("score") or 0) - int(previous_two[1].get("score") or 0)
        if first_gain < min_improvement and second_gain < min_improvement:
            reason = f"두 이터레이션 연속 점수 개선이 {min_improvement}점 미만입니다."
    if not reason:
        return current
    guarded = dict(current)
    guarded["decision"] = "needs_operator"
    guarded["verdict"] = "fail"
    guarded["summary"] = f"{reason} 반복 폭주를 막기 위해 사용자 확인 상태로 중단합니다."
    guarded["convergenceGuard"] = {"triggered": True, "reason": reason}
    return guarded


def should_adjudicate(assessment: dict[str, Any], margin: int) -> tuple[bool, str]:
    if not assessment.get("schemaValid", False):
        return True, "Critic 출력 계약이 유효하지 않습니다."
    if any(item.get("status") == "unknown" for item in assessment.get("hardGates", [])):
        return True, "Hard Gate 판정에 unknown이 있습니다."
    score = int(assessment.get("score") or 0)
    threshold = int(assessment.get("threshold") or 0)
    if threshold - margin <= score <= threshold + margin:
        return True, f"점수 {score}점이 통과선 {threshold}점의 ±{margin}점 경계 구간입니다."
    return False, ""


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ralph Critic 결정적 채점 엔진")
    subparsers = parser.add_subparsers(dest="command", required=True)
    evaluate_parser = subparsers.add_parser("evaluate")
    evaluate_parser.add_argument("--raw", type=Path, required=True)
    evaluate_parser.add_argument("--base", type=Path, required=True)
    evaluate_parser.add_argument("--task-rubric", type=Path, required=True)
    evaluate_parser.add_argument("--threshold", type=int, required=True)
    evaluate_parser.add_argument("--worker-exit", type=int, default=0)
    evaluate_parser.add_argument("--verifier-exit", type=int, default=0)
    evaluate_parser.add_argument("--stage", choices=("pre-worker", "post-worker"), required=True)
    evaluate_parser.add_argument("--history", type=Path)
    evaluate_parser.add_argument("--output", type=Path, required=True)
    evaluate_parser.add_argument("--strict", action="store_true", help="계약 오류 시 needs_operator JSON 대신 실패 코드로 종료합니다.")
    check_parser = subparsers.add_parser("check-rubric")
    check_parser.add_argument("--base", type=Path, required=True)
    check_parser.add_argument("--task-rubric", type=Path, required=True)
    boundary_parser = subparsers.add_parser("should-adjudicate")
    boundary_parser.add_argument("--assessment", type=Path, required=True)
    boundary_parser.add_argument("--margin", type=int, default=5)
    guard_parser = subparsers.add_parser("guard")
    guard_parser.add_argument("--assessment", type=Path, required=True)
    guard_parser.add_argument("--history", type=Path, required=True)
    guard_parser.add_argument("--output", type=Path, required=True)
    guard_parser.add_argument("--min-improvement", type=int, default=3)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "check-rubric":
        rubric = load_rubric(args.base, args.task_rubric)
        print(json.dumps({"ok": True, "task": rubric["task"], "criteria": len(rubric["criteria"]), "hardGates": len(rubric["hardGates"])}, ensure_ascii=False))
        return 0
    if args.command == "should-adjudicate":
        assessment = load_json(args.assessment)
        needed, reason = should_adjudicate(assessment, args.margin)
        print(json.dumps({"needed": needed, "reason": reason}, ensure_ascii=False))
        return 0 if needed else 1
    if args.command == "guard":
        assessment = load_json(args.assessment)
        guarded = apply_convergence_guard(assessment, args.history, args.min_improvement)
        write_json(args.output, guarded)
        return 0

    try:
        rubric = load_rubric(args.base, args.task_rubric)
        raw = load_json(args.raw)
        assessment = evaluate(
            raw,
            rubric,
            threshold=args.threshold,
            worker_exit=args.worker_exit,
            verifier_exit=args.verifier_exit,
            stage=args.stage,
        )
        assessment = apply_convergence_guard(assessment, args.history)
    except CriticContractError as error:
        if args.strict:
            print(f"ERROR: {error}", file=sys.stderr)
            return 2
        task = args.task_rubric.stem
        assessment = invalid_assessment(task, args.stage, args.threshold, str(error))
    write_json(args.output, assessment)
    return 0 if assessment.get("schemaValid") else 2


if __name__ == "__main__":
    raise SystemExit(main())

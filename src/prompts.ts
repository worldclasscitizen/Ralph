import type { CriticAssessment, TaskContract } from "./types.js";
import { loadRubric } from "./evaluator.js";

const CANONICAL_STATE = `현재 저장소 파일, Git HEAD·diff, 결정적 검증 결과가 세션 기억보다 우선합니다.
프로젝트 절대 경로 밖을 수정하지 마세요. Git commit·push·배포와 Ralph 내부 상태 변경을 하지 마세요.
비공개 사고과정을 출력하지 말고 판단 요약, 수행 행동, 검증 가능한 증거만 반환하세요.`;

export function contractPlannerPrompt(request: string, projectRoot: string): string {
  return `당신은 Ralph의 작업 계약 작성자입니다. 사용자의 자연어 요청을 하나의 실행 가능한 TaskContract JSON으로 바꾸세요.
${CANONICAL_STATE}

허용 taskType:
- planning_architecture
- frontend_visual
- backend_core
- tdd_debugging
- static_review
- delivery_evidence

사용자가 시간 부족, 가벼운 모델, 빠른 실행을 언급하면 executionProfile은 fast입니다.
최고 품질을 명시하면 quality, 비용 절약을 명시하면 budget, 그 외에는 balanced입니다.
검증 명령은 비대화형이며 실제 프로젝트에서 실행 가능한 것만 제안하세요.
요청하지 않은 외부 서비스 변경, 배포, push를 범위에 넣지 마세요.
JSON 객체만 출력하며 id, approvedHash, approvedAt은 생략하세요.

projectRoot: ${projectRoot}
사용자 요청:
${request}`;
}

export async function criticPrompt(
  contract: TaskContract,
  phase: "pre" | "post" | "adjudication",
  evidence: { head: string; status: string; diff: string; verifier?: string },
): Promise<string> {
  const rubric = await loadRubric(contract.taskType);
  return `당신은 독립적인 Ralph Critic입니다. ${phase} 평가를 수행하세요.
${CANONICAL_STATE}

임의 총점이나 최종 verdict를 만들지 마세요. 아래 criterion마다 level과 구체적인 증거만 반환하세요.
level은 absent, partial, verified, complete 중 하나입니다.
Hard Gate는 pass, fail, unknown 중 하나이며 추측하지 마세요.
findings severity는 low, medium, high, critical 중 하나입니다.
한국어 존댓말을 사용하세요.

공통 rubric:
${JSON.stringify(rubric.base)}

작업별 rubric:
${JSON.stringify(rubric.task)}

승인된 작업 계약:
${JSON.stringify(contract)}

Git HEAD: ${evidence.head}
Git status:
${evidence.status || "(clean)"}
Git diff:
${evidence.diff || "(none)"}
검증 증거:
${evidence.verifier ?? "(아직 실행되지 않음)"}

다음 JSON 형태만 출력하세요:
{"criteria":[{"id":"...","level":"absent|partial|verified|complete","evidence":["..."]}],"hardGates":[{"id":"...","status":"pass|fail|unknown","evidence":["..."]}],"findings":[{"severity":"low|medium|high|critical","summary":"...","evidence":["..."]}]}`;
}

export function metaPrompt(contract: TaskContract, assessment: CriticAssessment, progress: string): string {
  return `당신은 Ralph Meta-Prompter입니다. 승인된 작업 계약의 범위는 바꾸지 말고 Critic 증거를 다음 Worker가 해결할 실행 지시로 최적화하세요.
${CANONICAL_STATE}
한국어 존댓말로 작성하고, 구체적인 파일 후보·검증 순서·금지사항을 포함하세요.
JSON 객체 {"workerInstructions":"...","guardrailCandidate":"... 또는 빈 문자열"}만 출력하세요.

승인된 계약:
${JSON.stringify(contract)}

Critic 평가:
${JSON.stringify(assessment)}

최근 진행 요약:
${progress || "(첫 반복)"}`;
}

export function workerPrompt(contract: TaskContract, instructions: string, head: string): string {
  return `당신은 Ralph Worker입니다. 승인된 단일 작업 계약을 실제 프로젝트에 구현하세요.
${CANONICAL_STATE}
Git HEAD: ${head}
승인된 계약의 include 밖을 불필요하게 수정하지 말고 exclude는 절대 수정하지 마세요.
사용 가능한 도구 또는 현재 Agent CLI의 파일 도구로 구현하고, 검증을 실행하세요.
완료 후 변경 요약과 검증 증거를 한국어 존댓말로 반환하세요.

승인된 작업 계약:
${JSON.stringify(contract)}

이번 반복의 메타 지시:
${instructions}`;
}

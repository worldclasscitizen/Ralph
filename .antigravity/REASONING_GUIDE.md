# 멀티 프로바이더 Reasoning & Ralph 운영 가이드

> 검증 기준일: **2026-08-29 (Asia/Seoul)**
> 범위: 각 공급자의 공식 API 문서에 공개되어 실제 호출 가능한 모델 ID와 파라미터만 포함한다. Preview/실험 모델은 상태를 명시했으며, 루머·가상 ID·벤치마크 추정치는 제외했다.
> 모델 신선도 정책: 검증 기준일로부터 **출시 6개월이 지난 모델은 Active 여부와 무관하게 목록·예시·Fallback Chain에서 모두 제외**한다.

## 0. 먼저 알아야 할 설정 경계

- `.antigravity/config.json`은 프로젝트가 허용하는 Provider·공식 모델 ID·Reasoning 허용값·6대 태스크를 정의하는 **공유 규격/카탈로그**다. 개인 모델 조합이나 폴백 순서를 담지 않는다. Google Antigravity가 이 파일을 네이티브 설정으로 자동 로드한다는 공식 규격은 없다.
- `config.local.json`은 Git에 커밋하지 않는 **완전한 개인 설정**이다. 본인이 쓸 Provider 연결 방식, 선택 모델, 모델별 추론 강도, Worker의 6대 `taskPipelines`, Critic·Meta의 `ralph.fallbackChains`와 반복 기본값을 모두 명시한다. `.ralph/resolve-config.sh`는 이 값이 공용 catalog의 허용 범위 안인지 검증하고 Model ID·네이티브 reasoning parameter를 해석한다. API 키 실제 값은 어느 JSON에도 넣지 않는다.
- 공급자마다 파라미터의 **위치와 의미가 다르다**. 공통 `high` 문자열을 무작정 복사하지 말고 아래의 네이티브 요청 형태를 사용한다.
- 이 문서는 매월 공식 출시일을 다시 확인한다. 6개월 경계를 넘은 모델은 fallback으로 강등하지 않고 즉시 제거하며, 후속 최신 모델로 교체한다.

## 1. 공식 최신 모델과 추론 제어

### 1.1 Anthropic / Claude

[Claude 공식 모델 목록](https://platform.claude.com/docs/en/models/overview)은 현재 주력 라인업을 다음과 같이 명시한다.

| 용도 | 정확한 Claude API Model ID | Thinking | 공식 제어 규격 |
|---|---|---|---|
| 최고 성능·장기 에이전트 | `claude-fable-5` | Adaptive, 항상 켜짐 | `thinking` 필드를 생략하고 `output_config.effort`: `low`, `medium`, `high`, `xhigh`, `max`로 제어; 기본 `high` |
| 복잡한 agentic coding·기업 작업 | `claude-opus-5` | Adaptive | 위와 동일; 기본 `high`. `xhigh`/`max`에서 thinking 비활성화 요청은 400 |
| 속도/지능 균형 | `claude-sonnet-5` | Adaptive | 위와 동일; 기본 `high` |

Adaptive 예시:

```json
{
  "model": "claude-opus-5",
  "max_tokens": 65536,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "xhigh" }
}
```

`claude-fable-5`는 adaptive thinking이 항상 켜져 있으므로 위 예시와 달리 `thinking` 객체 자체를 생략하고 `output_config.effort`만 보낸다. `thinking.type="enabled"`의 manual budget과 `thinking.type="disabled"`는 모두 오류다.

주의 사항:

- 위 표는 Anthropic Messages API 규격이다. Claude Code 로그인형은 `claude auth login`으로 저장된 Claude.ai 구독 OAuth를 사용하며 API 키가 필요 없다. CLI 강도는 `claude --effort low|medium|high|max`로 전달하므로 이 저장소의 builtin 예제는 Fable/Opus에 `max`, Sonnet에 `high`를 사용한다.
- `ANTHROPIC_API_KEY`가 셸에 설정되어 있으면 `claude --print`에서 저장된 구독 로그인보다 우선할 수 있다. `.ralph/claude-builtin-agent.sh`는 Anthropic API·GLM endpoint override를 제거하고 `authMethod=claude.ai`, `apiProvider=firstParty`를 확인한다.
- 이 정책에 포함된 최신 Claude 라인은 수동 토큰 예산이 아니라 Adaptive Thinking을 사용한다. 따라서 `budget_tokens`를 설정하지 않고 `output_config.effort`로 강도를 제어한다. 세부 규격은 [Extended Thinking 공식 문서](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)를 따른다.
- effort는 엄격한 토큰 예산이 아니라 행동 신호다. 모델 ID의 날짜 유무 및 pinning 의미는 [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)을 따른다.
- API에서 여전히 Active인 모델이라도 출시 6개월 경계를 넘으면 이 저장소에서는 사용하지 않는다. 상태 변화는 [Model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)와 모델 출시일을 함께 확인한다.

### 1.2 OpenAI / Codex

| 용도 | 정확한 Model ID | 상태 | 공식 추론 강도 |
|---|---|---|---|
| 플래그십 복합 전문 작업 | `gpt-5.6-sol` | Current | `reasoning.effort`: `none`, `low`, `medium`(기본), `high`, `xhigh`, `max` |
| 비용/지능 균형 | `gpt-5.6-terra` | Current | 위와 동일 |
| 대량·비용 민감 작업 | `gpt-5.6-luna` | Current | 위와 동일 |

Responses API 네이티브 형식:

```json
{
  "model": "gpt-5.6-sol",
  "reasoning": { "effort": "xhigh" },
  "input": "요구사항을 분석하고 구현 계획을 작성하라."
}
```

GPT-5.6의 품질 우선 Pro mode는 별도 모델 ID가 아니다. 같은 ID를 유지하고 `reasoning.mode="pro"`를 추가하며, effort는 독립적으로 선택한다.

```json
{
  "model": "gpt-5.6-sol",
  "reasoning": { "mode": "pro", "effort": "xhigh" },
  "input": "데이터 손실 가능성이 있는 마이그레이션 계획을 독립 검토하라."
}
```

Chat Completions 또는 일부 IDE 어댑터는 같은 의미를 최상위 `reasoning_effort`로 평탄화한다. 공용 catalog는 공급자별 차이를 `reasoningSpec.parameter`, `allowedValues`, `recommendedValue`로 기록하고, 개인 설정은 `reasoningEffort` 하나를 선택한다. Resolver가 이를 실행용 `reasoning.parameter`, `value`, `allowedValues`로 해석하며 실제 어댑터는 `parameter`에 적힌 네이티브 위치를 사용한다. Codex 작업도 별도 구형 코딩 모델을 유지하지 않고 최신 5.6 계열을 작업 난도에 맞게 라우팅하며, 재현 가능한 제출물에는 표의 명시적 Model ID를 사용한다. 세부 근거는 [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [GPT-5.6 가이드](https://developers.openai.com/api/docs/guides/latest-model), [모델 카탈로그](https://developers.openai.com/api/docs/models)에서 확인한다.

### 1.3 Google Gemini

| 용도 | 정확한 Model ID | 상태 | Thinking 규격 |
|---|---|---|---|
| 최신 Flash | `gemini-3.7-flash` | Stable/GA | `thinkingLevel`: `low`, `medium`(기본), `high`; `minimal`은 오류 |
| 직전 Stable Flash | `gemini-3.6-flash` | Stable/GA | `minimal`, `low`, `medium`(기본), `high` |
| 범용 Stable Flash | `gemini-3.5-flash` | Stable/GA | `minimal`, `low`, `medium`(기본), `high` |

Gemini 3 REST 요청에서는 `generationConfig.thinkingConfig.thinkingLevel`을 사용한다.

```json
{
  "contents": [{ "parts": [{ "text": "이 UI 캡처의 정합성을 검사하라." }] }],
  "generationConfig": {
    "thinkingConfig": {
      "thinkingLevel": "high",
      "includeThoughts": true
    }
  }
}
```

- `includeThoughts`는 원시 chain-of-thought가 아니라 공식 thought summary를 요청한다.
- 이 정책의 Gemini 모델은 `thinkingBudget` 대신 `thinkingLevel`만 사용한다. 두 방식을 혼합하지 않는다.
- 현행 6개월 정책 안에 별도 Pro 모델이 없으므로 Pro라는 이름을 맞추기 위해 오래된 ID를 유지하지 않는다. 고난도 작업은 `gemini-3.7-flash`의 `high` 또는 다른 공급자의 최신 플래그십으로 라우팅한다. 근거: [모델 목록](https://ai.google.dev/gemini-api/docs/models), [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking), [Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash).

### 1.4 DeepSeek

| 용도 | 정확한 Model ID | 공식 상태 | 추론 제어 |
|---|---|---|---|
| 고성능 범용·코딩·추론 | `deepseek-v4-pro` | V4-Pro-0813 | Chat: `thinking.type` + `reasoning_effort`; Responses: `reasoning.effort` |
| 고속 범용·코딩·추론 | `deepseek-v4-flash` | V4-Flash-0731 | 위와 동일 |

- OpenAI 호환 Base URL: `https://api.deepseek.com`
- Chat Completions: `POST /chat/completions`
- Responses API: `POST /responses`
- Chat: `thinking.type`은 `enabled`(기본)/`disabled`, `reasoning_effort`는 `low`, `high`(기본), `max`다. 호환 입력 `medium`/`xhigh`는 `high`로 매핑되므로 네이티브 값 사용을 권장한다.
- Responses: `reasoning.effort`은 `none`, `low`, `high`, `max`; `none`은 thinking을 끈다.
- thinking 모드에서는 `temperature`, `top_p`, presence/frequency penalty가 효과가 없으므로 품질 조절 수단으로 오인하지 않는다.
- 종료되었거나 6개월 경계를 넘은 legacy alias는 문서와 설정에 보존하지 않는다.

```json
{
  "model": "deepseek-v4-pro",
  "messages": [{ "role": "user", "content": "실패한 테스트의 근본 원인을 찾아라." }],
  "thinking": { "type": "enabled" },
  "reasoning_effort": "max"
}
```

공식 근거: [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/), [Responses API](https://api-docs.deepseek.com/guides/responses_api/), [Change Log](https://api-docs.deepseek.com/updates/).

### 1.5 Zhipu AI / GLM

| 용도 | 정확한 Model ID | 공식 상태 | 추론 제어 |
|---|---|---|---|
| 최신 플래그십 코딩·에이전트 | `glm-5.3` | Current flagship | `thinking.type`은 `enabled`만; `reasoning_effort`: `low`, `high`, `max`(기본) |
| 최신 Flash 멀티모달 | `glm-5.3-flash` | Current Flash | `thinking.type`은 `enabled`만; `reasoning_effort`: `low`, `high`, `max`; 자동 기본값에 의존하지 말고 명시 |

- Z.AI 일반 API Base URL: `https://api.z.ai/api/paas/v4`
- Z.AI Coding Plan 전용 Base URL: `https://api.z.ai/api/coding/paas/v4`
- Z.AI Coding Plan의 Claude Code용 Anthropic 호환 Base URL: `https://api.z.ai/api/anthropic`
- 중국 본토 BigModel 플랫폼을 별도 계약/키로 사용할 때만 `https://open.bigmodel.cn/api/paas/v4`를 사용한다. Z.AI 키와 BigModel 키를 같은 것으로 가정하지 않는다.
- Chat Completions: `POST /chat/completions`
- `glm-5.3`/`glm-5.3-flash`는 항상 thinking을 사용한다. `thinking.type="disabled"`는 오류다.
- Plus/Pro 같은 제품 등급을 공식 표에 없는 Model ID로 조합하지 않는다.
- GLM Coding Plan endpoint는 지원되는 코딩 도구 전용이다. 일반 앱의 서버 API처럼 사용하지 않고, 일반 종량제 호출은 General API endpoint를 사용한다.

```json
{
  "model": "glm-5.3",
  "messages": [{ "role": "user", "content": "아키텍처 결함을 검토하라." }],
  "thinking": { "type": "enabled" },
  "reasoning_effort": "max"
}
```

공식 근거: [GLM-5.3 출시 및 API 변경](https://z.ai/blog/glm-5.3), [GLM-5.3-Flash 출시](https://z.ai/blog/glm-5.3-flash), [Z.AI Quick Start와 endpoint 구분](https://docs.z.ai/guides/overview/quick-start).

## 2. 작업 특화와 사용자별 Fallback Chain

하나의 전역 체인을 모든 사용자에게 강제하지 않는다. 각 사용자는 `config.local.json`에서 본인이 실제로 접근 가능한 Provider·모델만 선택하고 6대 `taskPipelines`를 직접 작성한다. 공유 `config.json`은 그 선택을 제한·검증할 catalog일 뿐 개인 체인을 소유하지 않는다. 아래 평가는 공식 포지셔닝과 API 기능을 바탕으로 한 **범용 라우팅 작성 예시**이며 절대 성능 순위가 아니다.

`taskPipelines`는 Worker 우선순위 원본이고 `commands.local.sh`가 alias별 실행기를 연결한다. Codex·Gemini·Claude는 로그인형 CLI로, DeepSeek는 자체 tool-call 하네스로, GLM Coding Plan은 공식 Claude Code 격리 브리지로 연결할 수 있다. 별도 종량제 `GLM_GENERAL_API_KEY`가 있는 사용자는 `zai-general`의 `glm-5-3-general` 또는 `glm-5-3-flash-general` alias를 선택해 동일한 직접 하네스를 쓸 수 있다.

| 공급자 | 무거운 작업에 우선 검토 | 빠른 반복에 우선 검토 | 특히 적합한 작업 | 주의점 |
|---|---|---|---|---|
| Anthropic | `claude-fable-5`, `claude-opus-5` | `claude-sonnet-5` | 장기 에이전트, 아키텍처, 코드 리뷰, 긴 문서 합성 | Adaptive Thinking과 effort를 함께 맞춰야 함 |
| OpenAI/Codex | `gpt-5.6-sol` xhigh | `gpt-5.6-terra` max, `gpt-5.6-luna` low | agentic coding, 복합 전문 작업, 구조화 검토, 이미지 기반 UI 판단 | task 난도에 따라 동일 세대 안에서 effort와 모델을 함께 조절 |
| Google | `gemini-3.7-flash` high | `gemini-3.6-flash`, `gemini-3.5-flash` | 빠른 멀티모달 UI 검증, 긴 입력, 대량 반복 | 현행 6개월 정책 안의 Pro ID가 없으므로 Flash를 타 공급자 플래그십과 조합 |
| DeepSeek | `deepseek-v4-pro` | `deepseek-v4-flash` | 비용 효율적인 코딩·디버깅·도구 호출 | 현재 V4 텍스트 라인을 UI 이미지 단독 판정자로 사용하지 않음 |
| Z.AI GLM | `glm-5.3` | `glm-5.3-flash` | 장기 코딩, agentic 실행, Flash의 멀티모달 UI 검증 | 5.3 계열은 thinking을 끌 수 없고 Coding endpoint 사용 범위가 제한됨 |

### 개인 설정 예시 A: Gemini + Codex/OpenAI + Claude + DeepSeek + GLM

여러 Provider를 사용할 수 있는 개인 `config.local.json` 작성 예시다.

| 태스크 | 개인 설정의 실제 순서(모델 + 추론 강도) | 기술적 근거 |
|---|---|---|
| ① 기획·아키텍처 | `gpt-5.6-sol` xhigh → `claude-fable-5` max → `glm-5.3` max → `deepseek-v4-pro` max → `gemini-3.7-flash` high | 복합 전문 추론 → 장기 계획 합성 → agentic 계획 → 교차 공급자 재검토 → 멀티모달 보완 |
| ② UI/UX·시각 검증 | `gemini-3.7-flash` high → `claude-sonnet-5` high → `gpt-5.6-sol` xhigh → `glm-5.3` max → `gpt-5.6-terra` max | 네이티브 멀티모달 → 빠른 코드·UI 검토 → 코드와 이미지 종합 → 플래그십 교차검증 |
| ③ 백엔드·코어 로직 | `gpt-5.6-sol` xhigh → `claude-opus-5` max → `glm-5.3` max → `deepseek-v4-pro` max → `gpt-5.6-terra` max | agentic coding → 복잡한 구현 재검토 → 긴 구현 루프 → 공급자 교차 디버깅 |
| ④ TDD·자율 디버깅 | `gpt-5.6-sol` xhigh → `claude-opus-5` max → `deepseek-v4-pro` max → `glm-5.3` max → `gpt-5.6-terra` max | 저장소·테스트 루프 → 장기 디버깅 → 원인 추론 → 장기 수정·검증 |
| ⑤ 정적 분석·코드 리뷰 | `claude-opus-5` max → `gpt-5.6-sol` xhigh → `gpt-5.6-terra` max → `deepseek-v4-pro` max → `glm-5.3` max | 독립 전문 검토 → 동세대 교차검토 → 공급자 교차검증 |
| ⑥ 배포·인수 증거 | `gemini-3.7-flash` high → `claude-fable-5` max → `gpt-5.6-sol` xhigh → `glm-5.3` max → `claude-sonnet-5` high | 산출물 정합성 → 장문 합성 → 정량 구조화 → 반론 검사 → 최종 문장 다듬기 |

### 개인 설정 예시 B: Gemini + Claude

| 태스크 | Primary → Secondary → Tertiary |
|---|---|
| ① 기획·아키텍처 | `claude-fable-5` max → `claude-sonnet-5` high → `gemini-3.7-flash` high |
| ② UI/UX·시각 검증 | `gemini-3.7-flash` high → `claude-sonnet-5` high → `claude-opus-5` high |
| ③ 백엔드·코어 로직 | `claude-opus-5` max → `claude-fable-5` high → `claude-sonnet-5` high |
| ④ TDD·자율 디버깅 | `claude-opus-5` max → `claude-fable-5` max → `claude-sonnet-5` high |
| ⑤ 정적 분석·코드 리뷰 | `claude-opus-5` high → `claude-fable-5` high → `gemini-3.7-flash` high |
| ⑥ 배포·인수 증거 | `gemini-3.7-flash` high → `claude-fable-5` max → `claude-sonnet-5` high |

### 개인 설정 예시 C: Claude only

| 태스크 | Primary → Secondary → Tertiary |
|---|---|
| ① 기획·아키텍처 | `claude-fable-5` max → `claude-opus-5` max → `claude-sonnet-5` high |
| ② UI/UX·시각 검증 | `claude-sonnet-5` high → `claude-opus-5` high → `claude-fable-5` high |
| ③ 백엔드·코어 로직 | `claude-opus-5` max → `claude-fable-5` high → `claude-sonnet-5` high |
| ④ TDD·자율 디버깅 | `claude-opus-5` max → `claude-fable-5` max → `claude-sonnet-5` high |
| ⑤ 정적 분석·코드 리뷰 | `claude-opus-5` high → `claude-fable-5` high → `claude-sonnet-5` high |
| ⑥ 배포·인수 증거 | `claude-fable-5` max → `claude-opus-5` high → `claude-sonnet-5` high |

같은 공급자 안의 fallback은 장애 격리 효과가 제한적이다. 단일 Provider 사용자는 장애 때 무한 재시도하지 말고 작업을 중단해 증거를 보존하며, 중요한 최종 결과는 가능하면 다른 Provider의 Critic으로 독립 검토한다.

### 공통 fallback 정책

1. `429`, timeout, `5xx`는 같은 모델을 최대 2회 시도하고 2초부터 최대 8초까지 지수 backoff한 뒤 다음 모델로 자동 전환한다. 같은 요청을 무한 반복하지 않는다.
2. Critic·Meta는 `ralph.fallbackChains`, Worker는 선택 task의 `taskPipelines` 순서를 사용한다. `commands.local.sh`에 해당 역할 명령이 없는 모델은 이벤트를 남기고 건너뛴다.
3. 인증, `400`/schema, 정책 거부, 알 수 없는 오류는 다른 모델로 우회하지 않고 중단해 설정·안전 문제를 숨기지 않는다.
4. 모델을 바꿀 때 같은 stage 입력 파일을 그대로 사용하므로 원 요청, 검증 로그, 이미 시도한 변경, 금지된 반복이 보존된다. 원시 비밀·PII·전체 `.env`는 넘기지 않는다.
5. 모든 재시도·강등·건너뛰기·성공은 `.ralph/runs/<run-id>/fallback-events.jsonl`에 기록한다.
6. 출력은 JSON Schema/테스트/린트/스크린샷 manifest 같은 결정적 verifier가 승인해야 한다. 모델의 “완료했습니다”는 완료 신호가 아니다.
7. 출시 6개월 경계를 넘은 모델은 tertiary에도 두지 않는다. 월 1회 공식 출시일을 재검증해 최신 허용 모델로 교체한다.

## 3. 배포·인수 증거 파이프라인

최종 검토자는 화려한 주장보다 **검증 가능한 증거 연결**을 안정적으로 평가한다. 태스크 ⑥은 다음 순서를 권장한다.

1. **캡처 고정**: 동일 commit SHA, seed 데이터, viewport(`1440x900`, `390x844`), locale, URL route, 사용자 역할, 촬영 시각을 `capture-manifest.json`에 기록한다.
2. **정합성 검사**: 요구사항/디자인 토큰/실제 캡처를 함께 입력하고, 요소별 `expected`, `observed`, `match`, `evidence_bbox`, `severity`를 JSON으로 받는다.
3. **정량 문제 정의**: 각 문제에 `baseline`, `target`, `delta`, `formula`, `sample_size`, `source`, `measurement_date`를 요구한다. 숫자 근거가 없으면 `unknown`으로 표시하고 만들어내지 않는다.
4. **기술 증거 연결**: 사용자 문제 → 기능 → 컴포넌트/API → 테스트 → 캡처 영역 → 기대 impact를 traceability ID로 연결한다.
5. **독립 critic**: 작성 모델과 다른 공급자가 루브릭으로 과장, 불일치, 캡처 미근거 주장, 테스트 누락을 공격적으로 찾는다.
6. **인수 패키지 생성**: 한 페이지 요약, 문제/해결/아키텍처, 전후 증거, 정량 표, 실행 경로, 제한사항, 재현 명령을 생성한다.

최종 주장 한 건의 권장 JSON 구조:

```json
{
  "claim_id": "IMP-003",
  "claim": "첫 작업 완료 시간을 40% 단축했다",
  "baseline": { "value": 250, "unit": "seconds", "n": 12 },
  "result": { "value": 150, "unit": "seconds", "n": 12 },
  "formula": "(baseline-result)/baseline*100",
  "evidence": ["metrics/task-time.csv", "screenshots/desktop-success.png"],
  "commit": "<git-sha>",
  "limitations": "내부 시나리오 12회 측정; 외부 사용자 연구 전"
}
```

## 4. 비용·재현성·보안 운영 원칙

- 모델 ID, effort, temperature 적용 여부, prompt hash, provider request ID, latency, token usage, verifier 결과를 run artifact에 남긴다.
- 배포 또는 인수 전 모델 목록은 각 공급자의 Models/List API와 위 공식 문서로 다시 확인한다. 별칭보다 명시적 ID/스냅샷을 우선한다.
- API key, access token, 개인 인증 파일이 포함된 로그는 저장소와 LLM prompt에 넣지 않는다.
- Ralph는 코드를 생성하는 Worker와 통과 여부를 판정하는 Critic을 논리적으로 분리하고, 결정적 테스트가 실패한 상태에서는 높은 LLM 점수만으로 종료하지 않는다.

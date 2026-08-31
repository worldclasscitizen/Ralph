import type { ProviderError, ProviderErrorKind } from "../types.js";

const RETRYABLE = new Set<ProviderErrorKind>([
  "rate_limit",
  "quota",
  "timeout",
  "server_error",
  "overloaded",
  "empty_response",
  "schema_error",
]);

export function classifyProviderError(input: {
  statusCode?: number;
  stderr?: string;
  message?: string;
  explicitKind?: ProviderErrorKind;
}): ProviderError {
  const text = `${input.message ?? ""}\n${input.stderr ?? ""}`.slice(0, 4_000);
  const lower = text.toLowerCase();
  let kind: ProviderErrorKind = input.explicitKind ?? "unknown";
  if (!input.explicitKind) {
    if (input.statusCode === 429 || /rate.?limit|too many requests/.test(lower)) kind = "rate_limit";
    else if (/quota|resource exhausted|credit balance/.test(lower)) kind = "quota";
    else if (/timed?\s*out|timeout|aborted/.test(lower)) kind = "timeout";
    else if ([500, 502, 503, 504].includes(input.statusCode ?? 0) || /server.?error|temporarily unavailable/.test(lower)) kind = "server_error";
    else if (/overloaded|capacity/.test(lower)) kind = "overloaded";
    else if ([401, 403].includes(input.statusCode ?? 0) || /unauthorized|authentication|not logged in|login required/.test(lower)) kind = "authentication";
    else if (/policy|safety|refus/.test(lower)) kind = "policy_denial";
    else if (input.statusCode === 400 || /invalid request|bad request/.test(lower)) kind = "invalid_request";
  }
  return {
    kind,
    message: text.trim() || `Provider 오류 (${kind})`,
    retryable: RETRYABLE.has(kind),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
  };
}

export function emptyResponseError(source: string): ProviderError {
  return {
    kind: "empty_response",
    message: `${source}가 성공 상태를 반환했지만 응답 본문이 비어 있습니다.`,
    retryable: true,
  };
}

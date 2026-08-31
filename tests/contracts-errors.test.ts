import { describe, expect, it } from "vitest";
import { approveContract, assertApproved, validateContract } from "../src/contracts.js";
import { classifyProviderError, emptyResponseError } from "../src/providers/errors.js";

describe("approval contract integrity", () => {
  it("accepts the unchanged approved contract and rejects a changed goal", () => {
    const root = "/tmp/example-project";
    const approved = approveContract(validateContract({
      taskType: "backend_core",
      goal: "검증 가능한 기능을 구현합니다.",
      acceptanceCriteria: ["테스트가 통과합니다."],
      executionProfile: "balanced",
    }, root));
    expect(() => assertApproved(approved)).not.toThrow();
    expect(() => assertApproved({ ...approved, goal: "승인 후 바뀐 목표" })).toThrow(/hash/);
  });
});

describe("provider error policy", () => {
  it.each([
    [{ statusCode: 429 }, "rate_limit", true],
    [{ message: "quota exhausted" }, "quota", true],
    [{ message: "request timed out" }, "timeout", true],
    [{ statusCode: 503 }, "server_error", true],
    [{ message: "service overloaded" }, "overloaded", true],
    [{ statusCode: 401 }, "authentication", false],
    [{ message: "safety policy refusal" }, "policy_denial", false],
    [{ statusCode: 400 }, "invalid_request", false],
  ] as const)("classifies %o as %s", (input, kind, retryable) => {
    expect(classifyProviderError(input)).toMatchObject({ kind, retryable });
  });

  it("treats an exit-0 empty response as retryable", () => {
    expect(emptyResponseError("critic")).toMatchObject({ kind: "empty_response", retryable: true });
  });
});

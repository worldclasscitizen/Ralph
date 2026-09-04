import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexBuiltinAdapter } from "../dist/providers/cli.js";
import { LiveBudget } from "./lib/live-budget.mjs";
import { solutions } from "./live-fixture.mjs";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const [mode, budgetPath, purpose, startingCalls, model] = process.argv.slice(2);
const criteria = ["contract_evidence", "deterministic_verification", "regression_scope_safety", "reproducibility", "api_contract_correctness", "data_business_integrity", "error_security_handling", "integration_evidence"];
const gates = ["worker_execution_failed", "deterministic_verifier_failed", "secret_or_user_data_exposure", "core_placeholder_claimed_complete", "tests_weakened", "destructive_out_of_scope_change", "core_contract_broken"];
try {
  if (mode === "mock") {
    let text;
    if (request.role === "worker") {
      for (const file of request.writePaths ?? Object.keys(solutions)) if (solutions[file]) await writeFile(join(request.projectRoot, file), solutions[file]);
      text = "Implemented and verified the assigned modules.";
    } else if (request.role === "metaPrompter") text = JSON.stringify({ workerInstructions: "Implement the approved contract.", guardrailCandidate: "" });
    else text = JSON.stringify({ criteria: criteria.map(id => ({ id, level: "complete", evidence: ["MOCK ONLY: deterministic fixture"] })), hardGates: gates.map(id => ({ id, status: "pass", evidence: ["MOCK ONLY"] })), findings: [] });
    const counter = JSON.parse(await readFile(budgetPath, "utf8")); counter.calls++; await writeFile(budgetPath, JSON.stringify(counter));
    console.log(JSON.stringify({ text, exitCode: 0 }));
  } else {
    const budget = new LiveBudget(budgetPath), state = await budget.load();
    if (state.calls - Number(startingCalls) >= 6) throw new Error("Comparison run reached its six-call ceiling");
    const adapter = new CodexBuiltinAdapter();
    const result = await budget.invoke(`${purpose}/${request.role}`, signal => adapter.invoke({ ...request,
      // Both runtimes use the exact same verified transport, model and fresh-session policy.
      model: { ...request.model, modelId: model, mode: "builtin", reasoningEffort: "low" }, sessionId: undefined,
      readPaths: ["**"], writePaths: request.role === "worker" ? request.writePaths ?? Object.keys(solutions) : [],
    }, signal));
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.log(JSON.stringify({ text: "", exitCode: 1, error: { kind: "policy_denial", retryable: false, message: String(error) } }));
}

/** Check retained outcomes and time before work; call estimates are informational. */
export function assertLiveCampaignReady(allowance, observations, mockObservations, needsConformance) {
  if (allowance.pending) throw new Error("Unconfirmed live call; inspect before continuing");
  if (observations.some(o => !o.passed)) throw new Error("A prior comparison failed; preserve it and review the evidence before another campaign");
  if (mockObservations.length !== 4 || mockObservations.some(o => !o.passed || !Number.isInteger(o.calls) || o.calls < 1)) throw new Error("Four successful mock observations with measured calls are required");
  const estimatedCalls = mockObservations.slice(observations.length).reduce((sum, o) => sum + o.calls, needsConformance ? 4 : 0);
  if (allowance.activeMs >= allowance.maxActiveMs) throw new Error("Active time allowance exhausted");
  return { estimatedCalls, remainingActiveMs: allowance.maxActiveMs - allowance.activeMs };
}
export function assertFunctionalPreflight(allowance, mock) {
  if (allowance.pending) throw new Error("Unconfirmed live call; inspect before continuing");
  if (mock.mode !== "mock" || !mock.passed || mock.status !== "completed" || mock.workerCount !== 2 || mock.calls !== 8) throw new Error("A successful eight-call generated-graph mock is required");
  if (allowance.activeMs >= allowance.maxActiveMs) throw new Error("Active time allowance exhausted");
  return { estimatedCalls: mock.calls, remainingActiveMs: allowance.maxActiveMs - allowance.activeMs };
}

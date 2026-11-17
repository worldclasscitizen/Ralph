import { expect, it } from "vitest";
import { antigravityWindows } from "../src/providers/antigravity-capacity.js";

it("reads official quota fractions and reset times without inventing balances", () => {
  const now = Date.parse("2026-11-17T00:00:00Z");
  expect(
    antigravityWindows(
      {
        "gemini-5h": {
          remaining_fraction: 0.8768,
          reset_time: "2026-11-17T03:00:00Z",
        },
        "gemini-weekly": { remaining_fraction: 0, reset_in_seconds: 7200 },
        "3p-5h": { remaining_fraction: 0.5, disabled: true },
        credits: { remaining_amount: 7 },
        "broken-fraction": { remaining_fraction: 101 },
      },
      now,
    ),
  ).toEqual([
    {
      label: "gemini-5h",
      remainingPercent: 87.7,
      durationMinutes: 300,
      resetsAt: "2026-11-17T03:00:00.000Z",
    },
    {
      label: "gemini-weekly",
      remainingPercent: 0,
      durationMinutes: 10080,
      resetsAt: "2026-11-17T02:00:00.000Z",
    },
  ]);
});

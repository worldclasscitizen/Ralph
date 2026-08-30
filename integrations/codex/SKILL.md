---
name: ralph
description: Convert a natural-language coding request into an approved Ralph task contract, run the platform-neutral Ralph CLI, and explain local evidence.
---

# Ralph

1. Determine the absolute Git project root. Never guess or use the current chat's directory without checking it.
2. Run `ralph doctor --project <absolute-root>` and explain any user action required for authentication.
3. Pass the user's full request to `ralph draft --project <absolute-root> --stdin --json` through stdin.
4. Run `ralph config explain --project <absolute-root> --profile <contract.executionProfile>` and show the returned contract, exact model route, exclusions, verification commands, and degraded capabilities to the user.
5. Do not modify code or approve on the user's behalf. Wait for explicit approval.
6. After approval, pipe the unchanged contract JSON to `ralph run --project <absolute-root> --contract-stdin --yes --events ndjson`.
7. Summarize only observable events, Git checkpoints, verifier evidence, and the final verdict. Never expose or infer hidden chain-of-thought.
8. Use `ralph status --project <absolute-root> --json`, `ralph logs --project <absolute-root> --follow`, or `ralph dashboard --project <absolute-root> --open` for monitoring.
9. If the user requests intervention, save a dashboard operator note for the next node or run `ralph stop --project <absolute-root>` for a safe stop.

# CLI reference additions

## Runtime routing

| Command | Purpose |
|---|---|
| `ralph config route list` | Show project-local route policies |
| `ralph config route set <task> --mode adaptive --candidate <connection=model@effort>` | Restrict the adaptive candidate portfolio |
| `ralph config route set <task> --mode fixed --candidate ...` | Preserve an exact fallback order |
| `ralph config route pin <role> --connection <id> --model <id> --effort <value>` | Hard-pin a route |
| `ralph config route unpin <role>` | Remove only the hard pin |
| `ralph config route reset <task>` | Restore generated defaults |
| `ralph config route explain <task>` | Explain the effective policy and candidates |
| <code>ralph config coverage show&#124;capture&#124;reset</code> | Inspect or update the project coverage ratchet |
| <code>ralph config invariant list&#124;add&#124;remove</code> | Manage frozen API, schema, policy, and golden paths |

## Benchmarks

| Command | Purpose |
|---|---|
| `ralph benchmark run [--case <id>] [--repetitions <n>]` | Run the packaged or selected live evaluation cases |
| `ralph benchmark compare <baseline> <candidate>` | Compare qualified quality, time, and token use |
| `ralph benchmark report <run-id>` | Read a saved local benchmark result |
| `ralph benchmark baseline set <run-id>` | Set the local comparison baseline |

All benchmark evidence is local under the project's Git-internal Ralph state. Source code, prompts, and run logs are not uploaded to a catalog service.

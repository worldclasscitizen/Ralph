# Install and first run

Ralph runs from a normal terminal. An AI chat product is an optional input surface, not the control plane.

```bash
npm install -g @worldclasscitizen/ralph@beta
cd /absolute/path/to/a/clean/git-project
ralph init
ralph doctor
ralph run "Improve the login flow and prove the result with tests"
```

Before code changes, review the generated contract, risk tier, deterministic checks, and selected Worker path. Ralph starts only after explicit approval.

Use `ralph dashboard --open` for the local UI or `ralph status --watch` and `ralph logs --follow` in terminal-only environments.

## Customize without writing six chains

Initialization generates all task and role routes. Most users do not need to edit them. Advanced users can restrict the candidate portfolio, fix an order, or hard-pin one route:

```bash
ralph config route set backend_core --mode adaptive \
  --candidate 'openai:codex-login=gpt-5.6-sol@xhigh' \
  --candidate 'anthropic:claude-login=claude-opus-5@max'

ralph config route pin worker \
  --connection openai:codex-login \
  --model gpt-5.6-sol \
  --effort xhigh

ralph config route unpin worker
```

API keys stay in the operating-system credential store or the provider environment variable. They are never stored in route configuration.

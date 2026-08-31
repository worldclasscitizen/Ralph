# Quality-first online routing

Ralph treats every authenticated provider connection as part of a user-owned model portfolio. It does not optimize for the cheapest acceptable answer.

The objective is lexicographic:

1. Maximize qualified quality and hard-gate success.
2. Among quality-equivalent choices, minimize elapsed time.
3. Among those choices, minimize cost or quota consumption.

The online Router runs only at meaningful decision boundaries. A deterministic policy filters unavailable, incapable, expired, capacity-exhausted, or unsafe choices before any model recommendation is accepted. The Router can select only from the approved candidate set.

`adaptive` lets Ralph choose within the user's candidate pool. `fixed` preserves the specified fallback order. A Hard Pin always wins; if it is unavailable or incapable, Ralph stops instead of silently overriding the user.

Routing decisions include the exact connection, model, effort, risk tier, verification tier, session policy, rationale, and policy hash. They are stored with run evidence.

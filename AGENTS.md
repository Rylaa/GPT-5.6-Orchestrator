# GPT-5.6 Orchestrator development policy

- Preserve a GPT-5.6 Sol `max` main session as planner and final authority.
- Every delegated Luna, Terra, and Sol worker uses reasoning effort `max`; model tier follows task shape.
- Keep the runtime Codex-only. Do not add provider-specific sidecars or a separate QA, reviewer, verifier, or judge stage.
- Keep hooks fail-open and observable. Treat them as workflow guardrails, not a security boundary.
- Write workers require explicit ownership, one active writer per Git workspace, and successful post-run ownership evidence. Use separate Git worktrees for parallel writers.
- Preserve schema-v2 proof compatibility while new workers emit schema v3 with requested-launch, observed-event, report, and ownership evidence.
- Run `npm run check`, plugin and skill validators, `npm audit --audit-level=high`, and `git diff --check` before release.
- Refresh the personal plugin cachebuster, reinstall the plugin and managed profiles, then verify source/cache parity before publishing.

# Changelog

## 0.3.0 - 2026-07-20

- Rename the plugin identity and checkout from the retired project name to `gpt-5-6-orchestrator`.
- Add private persistent Sol reasoning settings with `low`, `medium`, `high`, `xhigh`, and `max`; default to `high`.
- Add per-run `--sol-effort` overrides and bind delegated Sol worker routing and proof validation to each run's selected effort.
- Keep Luna and Terra workers at `max`, and document the separate Codex `/reasoning` and config controls for the active main session.

## 0.2.0 - 2026-07-20

- Run Luna, Terra, and delegated Sol workers at `max`; task shape selects the model tier.
- Unify hook and controller state under the plugin-managed data directory.
- Emit proof schema v3 with separate requested-launch and observed-runtime evidence, exact report validation, and write-ownership evidence; retain schema-v2 reads.
- Add hard execution timeouts, token-bound heartbeats, stale-state reconciliation, global concurrency limits, and one writer per Git worktree.
- Add bounded live activity, an optional right-side tmux dashboard, dry-run-first recoverable pruning, and canonical data-root discovery.
- Harden task parsing, path containment, report binding, runtime lifecycle checks, and Codex-only recursion guards.
- Add Node 20/22 CI, syntax validation, security audit, regression tests, and enforced global and critical-path coverage thresholds.

# Changelog

## 0.3.4 - 2026-07-21

- Add an Oh My Codex-inspired high-contrast ANSI palette to the right-side tmux panel, with distinct controller, model, state, activity, report, and metadata tones.
- Enable color automatically for tmux/interactive terminals, overriding Codex's inherited `NO_COLOR` only for the automatic pane; `GPT56_ORCHESTRATOR_COLOR=0` remains an explicit opt-out.
- Use stable cursor-preserving watch redraws with per-row erasure to prevent stale text, reduce flicker, and keep color rendering consistent.
- Adapt agent cards to the live pane height and width so narrow panes do not scroll into corrupted or unreadable redraws.

## 0.3.3 - 2026-07-21

- Keep all hook events working when a plugin upgrade prunes the version directory captured by an already-running Codex session.
- Validate fallback installations by plugin identity, version directory, regular files, and non-symlink entry points; remain fail-open when no valid installation exists.

## 0.3.2 - 2026-07-21

- Replace the terse tmux worker table with novice-readable live agent cards showing identity, task, current step, elapsed time, recent work, and report state.
- Translate bounded Codex JSON events into safe activity descriptions for source search, file inspection, Git checks, tests, builds, edits, tools, and agent updates.
- Redact credential-shaped text and never render raw commands, command output, full prompts, or hidden reasoning in the live panel.

## 0.3.1 - 2026-07-21

- Automatically open one right-side run dashboard when the first worker is launched from Codex inside tmux.
- Reuse a marked dashboard pane across concurrent and later workers, close it when the run becomes terminal, and reopen it for new activity.
- Keep automatic pane discovery fail-open and optional through `GPT56_ORCHESTRATOR_AUTO_PANE=0`; retain `pane --run` for manual recovery.

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

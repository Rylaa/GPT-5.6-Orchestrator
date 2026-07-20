# GPT-5.6 Orchestrator

### Sol Max leads the session. Luna, Terra, and Sol workers change with the task.

```text
+------------------------------------------------------------------+
|                    SOL MAX / MAIN SESSION                        |
|  understands -> decides -> assigns -> monitors -> accepts        |
+-------------------------------+----------------------------------+
                                |
             DYNAMIC CODEX SUBAGENTS (EXACT-PINNED EXTERNAL WORKERS)
       +------------------+------------------+------------------+
       | LUNA             | TERRA            | SOL              |
       | fast/exact       | broad/daily      | critical         |
       +------------------+------------------+------------------+
                                |
                      evidence -> Sol acceptance
```

This is a Codex-only Orchestrator, not a model fusion. GPT-5.6 Sol at `max` stays in the main interactive Codex session, owns planning and consequential decisions, and accepts the result. It dynamically opens bounded Luna, Terra, or additional Sol Codex workers only when useful.

Inspired by [Rylaa/fable5-orchestrator](https://github.com/Rylaa/fable5-orchestrator).

## Roles

| Worker | Model | Effort | Access |
|---|---|---|---|
| `orchestrator_luna_gatherer` | gpt-5.6-luna | low | read-only |
| `orchestrator_luna_worker` | gpt-5.6-luna | medium | workspace-write |
| `orchestrator_terra_explorer` | gpt-5.6-terra | medium | read-only |
| `orchestrator_terra_worker` | gpt-5.6-terra | high | workspace-write |
| `orchestrator_sol_specialist` | gpt-5.6-sol | max | workspace-write |

There is no worker judge and no automatic QA, reviewer, or verifier stage. Fresh-eyes inspection is an optional, risk-triggered closure choice owned by main Sol, with at most three verify/fix cycles. It is never a mandatory controller verdict or a retired worker role.

## Quickstart

Install from a checkout registered in your personal Codex marketplace. The legacy package ID remains `codex-sol-fusion` so existing installations update in place.

```sh
codex plugin add codex-sol-fusion@personal
codex -m gpt-5.6-sol -c 'model_reasoning_effort="max"' -c 'service_tier="fast"'
```

Trust the bundled hooks after inspecting `/hooks`; start a fresh Sol Max session after trust. Automatic activation applies to main-session prompts. Set `GPT56_ORCHESTRATOR_AUTO=0` to opt out, or use `$gpt-5-6-orchestrator <your task>` for one explicit session. `GPT56_ORCHESTRATOR_DISABLE=1` disables plugin hooks.

Codex plugin installation does not run lifecycle scripts or rewrite `~/.codex/AGENTS.md`.

## Controller

```sh
node scripts/orchestrator.mjs create --cwd "$PWD" --objective "audit and fix the target"
node scripts/orchestrator.mjs spawn --run <run-id> --worker scan --role orchestrator_terra_explorer --task-file .workflow/tasks/scan.md
node scripts/orchestrator.mjs status --run <run-id> --json
node scripts/orchestrator.mjs wait --run <run-id> --worker scan --timeout-seconds 30 --json
node scripts/orchestrator.mjs stop --run <run-id> --worker scan
```

Use `dashboard --run <id> [--watch] [--interval-ms <n>]` for a terminal status view. Use `pane --run <id> [--width <percent>] [--interval-ms <n>]` for an optional right-side tmux dashboard. The pane works only when Codex CLI is already inside tmux; it observes exact-pinned external workers and does not add a native Codex sidebar. tmux is optional, and no tmux or daemon is required for orchestration.

Write workers require `--allow-write --owns <path[,path]>`. Owned paths are normalized repository-relative paths; the controller rejects unsafe paths and rejects overlap with every active write worker. Read-only workers may run together, but dependency-ordered work does not.

## Task contract and ledger

Every detailed worker task names the objective, requirements, constraints, unknowns, dependencies, risks, exact inputs, allowed files or systems, acceptance checks, ledger item IDs, and the exact five-field return. Task files are regular non-symlink files inside the target repository. Workers do not ask users, spawn descendants, start nested Codex sessions, or claim final acceptance; they return ambiguity to Sol.

For serious work, `.workflow/LEDGER.md` holds stable requirement, constraint, and edge-case checkboxes. IDs are cited by tasks and reports. `[x]` closes an item. `[~] deferred: user-approved ...` is the only deferral marker treated as closed; an unapproved or differently worded deferral stays open.

The controller captures every worker's final five-field response in a private `report.md`. Write workers may also use their private `scratch/` directory for bulky evidence; read-only workers keep the repository and scratch read-only and return evidence through the report. The handoff must state: ledger items addressed and scope; evidence and files changed; verification result; risks and unresolved issues; confidence and out-of-scope findings. Main Sol reads the report and proof, inspects current artifacts, and decides task acceptance; runtime proof alone is not semantic success.

## Native visibility and proof

Native Codex subagents appear as Desktop threads, through CLI `/agent`, or in the IDE background-agent panel. Those native children are not substituted for named lanes while the active tool schema cannot prove exact role, model, and effort pins. The controller instead launches independently logged `codex exec` workers with exact model, effort, sandbox, and fast service-tier settings. Completion requires a non-empty thread ID, completed turn event, zero exit, non-empty report, and matching `proof.json` schema v2. That proof records both recursion guards: native multi-agent spawning disabled and Orchestrator hooks disabled. Process launch alone is not success.

Managed access values are defaults; live permission and sandbox policy remain authoritative. Hooks and process controls are workflow reminders, not a security boundary.

## License

MIT. See [NOTICE](NOTICE).

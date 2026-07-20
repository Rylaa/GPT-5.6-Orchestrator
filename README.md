# GPT-5.6 Orchestrator

### Sol Max leads. The task chooses Luna, Terra, or Sol; every worker reasons at max.

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
| `orchestrator_luna_gatherer` | gpt-5.6-luna | max | read-only |
| `orchestrator_luna_worker` | gpt-5.6-luna | max | workspace-write |
| `orchestrator_terra_explorer` | gpt-5.6-terra | max | read-only |
| `orchestrator_terra_worker` | gpt-5.6-terra | max | workspace-write |
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
The plugin skill and hooks carry the runtime policy. `AGENTS.md` is Codex's durable
repository guidance surface; this checkout includes one for contributors.

The controller does not depend on native agent profiles. To mirror the bundled
roles into `~/.codex/agents` for `/agent` discovery, run this optional step from
the checkout or installed plugin root:

```sh
node scripts/manage-agent-profiles.mjs install
```

## Controller

```sh
node scripts/orchestrator.mjs create --cwd "$PWD" --objective "audit and fix the target"
node scripts/orchestrator.mjs spawn --run <run-id> --worker scan --role orchestrator_terra_explorer --task-file .workflow/tasks/scan.md --execution-timeout-seconds 1800
node scripts/orchestrator.mjs status --run <run-id> --json
node scripts/orchestrator.mjs wait --run <run-id> --worker scan --timeout-seconds 30 --json
node scripts/orchestrator.mjs stop --run <run-id> --worker scan
node scripts/orchestrator.mjs data-dir
node scripts/orchestrator.mjs prune --older-than-hours 168
```

An installed controller derives the same plugin-managed data root that hooks use;
`GPT56_ORCHESTRATOR_DATA_DIR` remains the explicit standalone/test override.

Use `dashboard --run <id> --watch` for status, elapsed time, and bounded live
activity. It exits when all workers finish; add `--keep-open` to retain it. tmux is optional:
`pane --run <id>` shows the same view in a right-side pane only when Codex CLI is
already inside tmux; it is not a native Codex sidebar.

Write workers require `--allow-write --owns <path[,path]>` and a Git worktree.
Only one writer may run in a Git workspace across all runs; use separate worktrees
for parallel writers. A post-run Git-visible plus workflow-contract snapshot rejects
successful proof when changes escape ownership. This remains a workflow guardrail,
not filesystem confinement. Read-only workers may run together.

Worker execution has a hard timeout. Stop signals only a process with a fresh,
token-matching heartbeat. `prune` is dry-run by default; `--apply` moves only old,
terminal runs into recoverable plugin `trash/` storage and never deletes active data.

## Task contract and ledger

Every detailed worker task names the objective, requirements, constraints, unknowns, dependencies, risks, exact inputs, allowed files or systems, acceptance checks, ledger item IDs, and the exact five-field return. Task files are regular non-symlink files inside the target repository. Workers do not ask users, spawn descendants, start nested Codex sessions, or claim final acceptance; they return ambiguity to Sol.

For serious work, `.workflow/LEDGER.md` holds stable requirement, constraint, and edge-case checkboxes. IDs are cited by tasks and reports. `[x]` closes an item. `[~] deferred: user-approved ...` is the only deferral marker treated as closed; an unapproved or differently worded deferral stays open.

The controller captures every worker's final five-field response in a private `report.md`. Write workers may also use their private `scratch/` directory for bulky evidence; read-only workers keep the repository and scratch read-only and return evidence through the report. The handoff must state: ledger items addressed and scope; evidence and files changed; verification result; risks and unresolved issues; confidence and out-of-scope findings. Main Sol reads the report and proof, inspects current artifacts, and decides task acceptance; runtime proof alone is not semantic success.

## Native visibility and proof

Native Codex subagents appear as Desktop threads, through CLI `/agent`, or in the IDE background-agent panel. Those native children are not substituted for named lanes while the active tool schema cannot prove exact role, model, and effort pins. The controller launches logged `codex exec` workers with requested model, max effort, sandbox, and fast-tier arguments. Matching `proof.json` schema v3 separates that requested launch contract from runtime-observed `thread.started` and `turn.completed` events; current events do not attest model or effort. Completion also requires zero exit, an exact non-empty five-field report with digest, valid ownership evidence, native multi-agent spawning disabled, plugin discovery disabled, and Orchestrator hooks disabled. Schema-v2 proofs remain readable for compatibility. Process launch alone is not success, and main Sol still owns semantic acceptance.

## Development checks

```sh
npm ci
npm run check
npm audit --audit-level=high
git diff --check
```

CI runs syntax and the complete test suite on Node 20, then enforces full and
critical-path coverage thresholds on Node 22.

Managed access values are defaults; live permission and sandbox policy remain authoritative. Hooks and process controls are workflow reminders, not a security boundary.

## License

MIT. See [NOTICE](NOTICE).

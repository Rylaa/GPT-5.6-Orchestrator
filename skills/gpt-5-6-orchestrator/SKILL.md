---
name: gpt-5-6-orchestrator
description: Use when the user requests GPT-5.6 Orchestrator, Sol-led dynamic workflows, or task-shaped delegation among GPT-5.6 Sol, Terra, and Luna.
---

# GPT-5.6 Orchestrator

Keep GPT-5.6 Sol at `max` in the main interactive session. That main Sol session is the permanent chair: it understands the request, makes the plan, chooses and controls workers, resolves every consequential decision, performs the most important reasoning, and owns final acceptance. Luna, Terra, and additional Sol processes are bounded workers, never co-equal decision makers.

Once this installed plugin's command hooks are trusted, its `UserPromptSubmit` hook activates the workflow automatically for every main-session prompt. The exact `$gpt-5-6-orchestrator` token remains an explicit fallback when `GPT56_ORCHESTRATOR_AUTO=0`; `GPT56_ORCHESTRATOR_DISABLE=1` disables all plugin hooks. Never apply main-session activation to child-agent prompts.

## Runtime contract

Start the main session with:

```sh
codex -m gpt-5.6-sol -c 'model_reasoning_effort="max"' -c 'service_tier="fast"'
```

If the active main session is not GPT-5.6 Sol at `max`, do not pretend it is the orchestrator. Explain the mismatch and give the restart command. Do not place Luna or Terra in the coordinator seat.

The active direct collaboration schema cannot select a named profile, model, or reasoning effort, and its alternate Sol-root schema is rejected by the backend. For current exact routing, use only the bundled `scripts/orchestrator.mjs` controller. It starts independently logged background `codex exec` subagents. Do not start ad hoc nested Codex processes and do not use a generic native child for a named lane. Prefer native Codex subagents if a future active schema can prove the exact requested model and effort.

The main Sol session remains the scheduler. The bundled controller performs only Sol's explicit lifecycle, visibility, and retention commands; it never decides which worker to use or what result to accept.

Native Codex subagents are visible as Desktop threads, through CLI `/agent`, or in the IDE background-agent panel. They are not substitutes for these named lanes until the active tool schema proves the exact role, model, and effort pins.

## Dynamic worker control

Resolve `<plugin-root>` from this installed skill's location, then use the bundled controller:

```sh
node <plugin-root>/scripts/orchestrator.mjs create --cwd "$PWD" --objective "<bounded objective>"
node <plugin-root>/scripts/orchestrator.mjs spawn --run <run-id> --worker <id> --role <role> --task-file <repo-local-task-file> --execution-timeout-seconds 1800
node <plugin-root>/scripts/orchestrator.mjs status --run <run-id> --json
node <plugin-root>/scripts/orchestrator.mjs dashboard --run <run-id> --watch --interval-ms 1000
node <plugin-root>/scripts/orchestrator.mjs pane --run <run-id> --width 40 --interval-ms 1000
node <plugin-root>/scripts/orchestrator.mjs wait --run <run-id> --worker <id> --timeout-seconds 30 --json
node <plugin-root>/scripts/orchestrator.mjs stop --run <run-id> --worker <id>
node <plugin-root>/scripts/orchestrator.mjs data-dir
node <plugin-root>/scripts/orchestrator.mjs prune --older-than-hours 168
```

An installed controller derives the same plugin-managed data root that Codex passes to plugin hooks. `GPT56_ORCHESTRATOR_DATA_DIR` is the explicit standalone/test override. `dashboard` shows status, elapsed time, and bounded activity metadata for exact-pinned external workers; watched dashboards exit when all workers are terminal unless `--keep-open` is supplied. `pane` opens that dashboard in an optional right-side tmux view and works only when Codex CLI is already inside tmux; it is not a native Codex sidebar.

Task files must be regular non-symlink files inside the target working directory. Add `--allow-write --owns <path[,path]>` only after Sol has bounded a write worker's files and acceptance criteria. A write worker requires a Git worktree, only one writer may be active per workspace across runs, and parallel writers use separate worktrees. Post-run Git-visible and workflow-contract snapshots reject successful proof when changes escape ownership; this is detection, not filesystem confinement. The controller caps all active workers across runs at eight. Worker execution has a hard timeout, and Stop signals only a process with a fresh token-matching heartbeat. `prune` is dry-run unless `--apply` is supplied, and applied pruning moves only old terminal runs into recoverable plugin trash.

New workers emit proof schema v3. It separates the requested model/effort/sandbox/tier launch contract from the runtime-observed Codex thread and completed-turn events, because current event JSON does not attest model or effort. Completion also requires a valid exact five-field report and ownership evidence. Schema-v2 proofs remain readable. Read the private report and proof; never treat process launch success as task success.

## Roles

| Role | Model and effort | Access | Use |
|---|---|---|---|
| `orchestrator_luna_gatherer` | Luna, max | read-only | Known-source extraction, classification, structured summaries |
| `orchestrator_luna_worker` | Luna, max | workspace-write | Exact repeatable edits and focused tests |
| `orchestrator_terra_explorer` | Terra, max | read-only | Broad repository scans, large files, research synthesis |
| `orchestrator_terra_worker` | Terra, max | workspace-write | Everyday implementation, integration, root-cause fixes |
| `orchestrator_sol_specialist` | Sol, max | workspace-write | Critical, deeply coupled, novel, ambiguity-heavy implementation |

There is no worker judge or separate QA stage. The Sol Max main session is the judge. An additional Sol process may be a bounded specialist, but it cannot take over orchestration or final acceptance.

## Routing policy

Classify each lane by ambiguity, breadth, repeatability, write scope, dependency, blast radius, and consequence.

1. Keep orchestration, architecture, tradeoffs, conflicting evidence, security/auth/money decisions, destructive choices, irreversible risk, and final acceptance in the Sol Max main session.
2. Give Luna only clear, repeatable work with exact inputs, outputs, file boundaries, and acceptance criteria.
3. Give Terra broad read-heavy exploration and everyday work that needs real judgment, integration, or root-cause analysis.
4. Give the most critical, deeply coupled, novel, or ambiguity-heavy implementation to `orchestrator_sol_specialist` after the main Sol session decides the direction.
5. Do not silently substitute models or efforts. If a required pin is unavailable, mark that lane unverified.

Every delegated role uses reasoning effort `max`. Task shape selects the model tier; lowering effort is not the cost-control mechanism.

Prompt length controls ledger policy, not model routing.

## Task and ledger contract

Every detailed task names its objective, requirements, constraints, unknowns, dependencies, risks, exact inputs, allowed scope, acceptance checks, ledger item IDs, and the exact five-field return. Serious work uses `.workflow/LEDGER.md` for stable requirement, constraint, and edge-case checkboxes. `[x]` closes an item; `[~] deferred: user-approved ...` is the only deferral marker treated as closed. Unapproved or differently worded deferrals remain open. The controller captures every worker's final response in private `report.md`; write workers may also use private `scratch`, while read-only workers return bulky evidence through the report without attempting scratch writes. Runtime proof establishes the requested isolated process identity and records the enforced recursion-guard configuration, not semantic task success; main Sol must inspect and accept the report. Workers do not ask users, spawn descendants, start nested sessions, or claim acceptance; ambiguity returns to Sol.

## Clarification gate

Decompose every request into task-shaped lanes before acting, even when efficiency calls for one inline lane and no worker. Resolve safely discoverable facts from the workspace before asking the user. If remaining ambiguity can materially change scope, architecture, a destructive or external action, cost, security, acceptance criteria, or user-visible behavior, the main Sol session asks concise grouped clarification before delegation or mutation. Workers never ask the user; they stop their lane and return the ambiguity to main Sol. Do not ask about repo-discoverable choices such as file layout, local git use, or test commands. Ask before unrequested external publication, destructive actions, or materially different user-visible behavior.

## Workflow

1. Sol reads the request and current evidence, decomposes it, and applies the clarification gate. For serious multi-step work, create `.workflow/LEDGER.md` with stable requirement, constraint, and edge-case checkboxes.
2. Sol creates one orchestration run when workers are useful. Spawn workers dynamically as evidence changes; a static all-at-once plan is not required.
3. Parallelize only independent discovery or disjoint file ownership. Never run overlapping writers or dependency-ordered steps concurrently.
4. Sol monitors worker status and may stop or replace a worker. A worker returns evidence to Sol; it does not assign follow-up work.
5. Sol handles consequential edits inline or assigns an approved bounded critical implementation to `orchestrator_sol_specialist`.
6. Write workers run focused tests inside their assigned lane. Do not launch a separate QA, reviewer, or verifier phase automatically.
7. For genuinely risky work, Sol may perform fresh-eyes inspection and at most three verify/fix cycles; this is optional, main-agent-owned closure, not a controller verdict or retired role.
8. Sol reconciles evidence, checks the current artifacts and git diff, closes ledger items, and decides final acceptance. Worker output is evidence, not a vote.

## Performance policy

- Do not delegate a tiny task when worker startup costs more than doing it in the main Sol session.
- Batch related evidence into bounded worker tasks and reuse one run rather than creating many runs.
- Prefer Luna for mechanical speed, Terra for broad/context-heavy work, and additional Sol only for frontier reasoning or high-risk verification.
- Poll with short `status` or bounded `wait` calls; keep the main session responsive.
- Every worker runs at `max` on service tier `fast`, has lean isolated context, writes durable artifacts, and cannot spawn descendants. The fallback controller ignores unrelated user config, disables plugin discovery and the remote plugin catalog so unused plugin skills and hooks do not enter worker context, forces `GPT56_ORCHESTRATOR_DISABLE=1` as defense in depth, and passes every required model, effort, sandbox, and tier setting explicitly.
- The main Sol session may open new workers as the task evolves, using a lead-session plus dynamic-worker pattern.

Hooks and process controls are workflow guardrails, not a security boundary. The live sandbox and permission policy remain authoritative.

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

Codex CLI 0.144.4's direct `collaboration.spawn_agent` schema cannot select a named profile, model, or reasoning effort, and its alternate Sol-root schema is rejected by the backend. For current exact routing, use only the bundled `scripts/orchestrator.mjs` controller. It starts independently logged background `codex exec` subagents with no terminal multiplexer or daemon. Do not start ad hoc nested Codex processes and do not use a generic native child for a named lane. Prefer native Codex subagents if a future active schema can prove the exact requested model and effort.

The main Sol session remains the scheduler. The bundled controller only performs Sol's explicit `create`, `spawn`, `status`, `wait`, and `stop` commands; it never decides which worker to use or what result to accept.

## Dynamic worker control

Resolve `<plugin-root>` from this installed skill's location, then use the bundled controller:

```sh
node <plugin-root>/scripts/orchestrator.mjs create --cwd "$PWD" --objective "<bounded objective>"
node <plugin-root>/scripts/orchestrator.mjs spawn --run <run-id> --worker <id> --role <role> --task-file <repo-local-task-file>
node <plugin-root>/scripts/orchestrator.mjs status --run <run-id> --json
node <plugin-root>/scripts/orchestrator.mjs wait --run <run-id> --worker <id> --timeout-seconds 30 --json
node <plugin-root>/scripts/orchestrator.mjs stop --run <run-id> --worker <id>
```

Task files must be regular non-symlink files inside the target working directory. Add `--allow-write` only after Sol has bounded a write worker's files and acceptance criteria. The controller caps a run at eight active workers. Every completed worker must have a non-empty `threadId`, a completed runtime event, and a `proof.json` whose role, model, effort, sandbox, and service tier match the requested lane. Read the worker's `result.md` and proof; never treat process launch success as task success.

## Roles

| Role | Model and effort | Access | Use |
|---|---|---|---|
| `orchestrator_luna_gatherer` | Luna, low | read-only | Known-source extraction, classification, structured summaries |
| `orchestrator_luna_worker` | Luna, medium | workspace-write | Exact repeatable edits and focused tests |
| `orchestrator_luna_reviewer` | Luna, high | read-only | Narrow checklist review after writer and tests |
| `orchestrator_terra_explorer` | Terra, medium | read-only | Broad repository scans, large files, research synthesis |
| `orchestrator_terra_worker` | Terra, high | workspace-write | Everyday implementation, integration, root-cause fixes |
| `orchestrator_terra_reviewer` | Terra, high | read-only | Cross-file logic, large diffs, assumptions, edge cases |
| `orchestrator_sol_specialist` | Sol, max | workspace-write | Critical, deeply coupled, novel, ambiguity-heavy implementation |
| `orchestrator_sol_verifier` | Sol, max | read-only | Fresh independent closure for genuinely high-risk work |

There is no worker judge. The Sol Max main session is the judge. An additional Sol process may be a bounded specialist or independent verifier, but it cannot take over orchestration or final acceptance.

## Routing policy

Classify each lane by ambiguity, breadth, repeatability, write scope, dependency, blast radius, and consequence.

1. Keep orchestration, architecture, tradeoffs, conflicting evidence, security/auth/money decisions, destructive choices, irreversible risk, and final acceptance in the Sol Max main session.
2. Give Luna only clear, repeatable work with exact inputs, outputs, file boundaries, and acceptance criteria.
3. Give Terra broad read-heavy exploration and everyday work that needs real judgment, integration, or root-cause analysis.
4. Give the most critical, deeply coupled, novel, or ambiguity-heavy implementation to `orchestrator_sol_specialist` after the main Sol session decides the direction.
5. Use `orchestrator_sol_verifier` only for fresh high-risk closure. The main Sol session still decides whether to accept the result.
6. Do not silently substitute models or efforts. If a required pin is unavailable, mark that lane unverified.

Prompt length controls ledger policy, not model routing.

## Clarification gate

Decompose every request into task-shaped lanes before acting, even when efficiency calls for one inline lane and no worker. Resolve safely discoverable facts from the workspace before asking the user. If remaining ambiguity can materially change scope, architecture, a destructive or external action, cost, security, acceptance criteria, or user-visible behavior, the main Sol session asks concise clarification before delegation or mutation. Workers never ask the user; they stop their lane and return the ambiguity to main Sol. Do not delay safe, reversible work with unnecessary questions.

## Workflow

1. Sol reads the request and current evidence, decomposes it into task-shaped lanes, and applies the clarification gate. For serious multi-step work, create `.workflow/LEDGER.md` with stable requirement, constraint, and edge-case checkboxes.
2. Sol decides the first routing wave and creates one orchestration run. Spawn workers dynamically as evidence changes; a static all-at-once plan is not required.
3. Parallelize only independent discovery or disjoint file ownership. Never run overlapping writers, a writer with its reviewer, or dependency-ordered work concurrently.
4. Sol monitors worker status and may stop or replace a worker. A worker returns evidence to Sol; it does not assign follow-up work.
5. Sol handles the can-alici reasoning and consequential edits inline or assigns an approved bounded critical implementation to `orchestrator_sol_specialist`.
6. Run direct tests after writers. Only then start Luna checklist review or Terra cross-file review.
7. Complete three verification cycles for serious work: direct tests, role-appropriate review, and Sol main-session acceptance. Add the independent Sol verifier only when risk justifies its latency.
8. Sol reconciles evidence, checks every ledger item, inspects current files and git diff, and produces the final answer. Worker consensus is evidence, not a vote.

## Performance policy

- Do not delegate a tiny task when worker startup costs more than doing it in the main Sol session.
- Batch related evidence into bounded worker tasks and reuse one run rather than creating many runs.
- Prefer Luna for mechanical speed, Terra for broad/context-heavy work, and additional Sol only for frontier reasoning or high-risk verification.
- Poll with short `status` or bounded `wait` calls; keep the main session responsive.
- Every worker runs on service tier `fast`, has lean isolated context, writes durable artifacts, and cannot spawn descendants. The fallback controller ignores unrelated user config, forces `GPT56_ORCHESTRATOR_DISABLE=1` in worker runtimes to prevent recursive orchestration, and passes every required model, effort, sandbox, and tier setting explicitly.
- The main Sol session may open new workers as the task evolves, matching Claude Code Dynamic Workflows' lead-session plus dynamic-subagent pattern.

Hooks and process controls are workflow guardrails, not a security boundary. The live sandbox and permission policy remain authoritative.

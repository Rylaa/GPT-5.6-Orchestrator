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

The main Sol session remains the scheduler. The bundled controller performs only Sol's explicit `create`, `spawn`, `test`, `status`, `wait`, `close`, and `stop` commands; it never decides which worker to use or what result to accept. `close` records an acceptance only after the main Sol session supplies the verdict and all tier evidence validates.

## Dynamic worker control

Resolve `<plugin-root>` from this installed skill's location, then use the bundled controller:

```sh
node <plugin-root>/scripts/orchestrator.mjs create --cwd "$PWD" --objective "<bounded objective>" --qa-tier <q0|q1|q2|q3>
node <plugin-root>/scripts/orchestrator.mjs spawn --run <run-id> --worker <id> --role <role> --task-file <repo-local-task-file>
node <plugin-root>/scripts/orchestrator.mjs test --run <run-id> --test-id <id> -- <command> [args...]
node <plugin-root>/scripts/orchestrator.mjs status --run <run-id> --json
node <plugin-root>/scripts/orchestrator.mjs wait --run <run-id> --worker <id> --timeout-seconds 30 --json
node <plugin-root>/scripts/orchestrator.mjs close --run <run-id> --sol-verdict accepted
node <plugin-root>/scripts/orchestrator.mjs stop --run <run-id> --worker <id>
```

Task files must be regular non-symlink files inside the target working directory. Add `--allow-write` only after Sol has bounded a write worker's files and acceptance criteria. The controller caps a run at eight active workers. Every completed worker must have a non-empty `threadId`, a completed runtime event, and a `proof.json` whose role, model, effort, sandbox, and service tier match the requested lane. Read the worker's `result.md` and proof; never treat process launch success as task success. Test and review proofs are tied to a workspace digest that excludes `.workflow` metadata, so ledger updates and git commits do not invalidate current QA evidence.

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

Decompose every request into task-shaped lanes before acting, even when efficiency calls for one inline lane and no worker. Resolve safely discoverable facts from the workspace before asking the user. If remaining ambiguity can materially change scope, architecture, a destructive or external action, cost, security, acceptance criteria, or user-visible behavior, the main Sol session asks concise grouped clarification before delegation or mutation. Workers never ask the user; they stop their lane and return the ambiguity to main Sol. Do not ask about repo-discoverable choices such as file layout, local git use, or test commands. Ask before unrequested external publication, destructive actions, or materially different user-visible behavior.

## Risk-based QA

Select the QA tier after clarification and before implementation. Record it as `QA-Tier: QN` in `.workflow/LEDGER.md` for ledger-backed work and pass the same tier to `create`.

| Tier | Use | Required closure evidence |
|---|---|---|
| `Q0` | Tiny, read-only, or safely reversible inline work | Sol self-check; no QA worker |
| `Q1` | Bounded normal code change | Current direct test plus `orchestrator_luna_reviewer` |
| `Q2` | Cross-file, integration, or root-cause work | Current direct test plus `orchestrator_terra_reviewer` |
| `Q3` | Auth, security, money, migration, or genuinely high risk | Current direct test, Terra review, then `orchestrator_sol_verifier` |

Do not create a permanent QA agent. Use the existing reviewer roles only when the selected tier requires them. Run tests through the controller after writers finish. Start reviewers only after current tests pass. For Q3, start the Sol verifier only after Terra review finishes. Close the ledger, inspect all evidence, and run `close`; it writes `.workflow/closure.json` plus a private controller receipt. A ledger-backed final completion claim is valid only while those records match, the closure matches the current workspace digest, and it contains Sol's explicit `accepted` verdict.

## Workflow

1. Sol reads the request and current evidence, decomposes it, applies the clarification gate, locks scope, and selects Q0-Q3. For ledger-backed work, only then create `.workflow/LEDGER.md` with stable requirement, constraint, edge-case, and QA checkboxes.
2. Sol creates one orchestration run at the selected tier when workers or QA evidence are needed. Spawn workers dynamically as evidence changes; a static all-at-once plan is not required.
3. Parallelize only independent discovery or disjoint file ownership. Never run overlapping writers, a writer with its reviewer, or dependency-ordered work concurrently.
4. Sol monitors worker status and may stop or replace a worker. A worker returns evidence to Sol; it does not assign follow-up work.
5. Sol handles the can-alici reasoning and consequential edits inline or assigns an approved bounded critical implementation to `orchestrator_sol_specialist`.
6. Run targeted direct tests through `test` after writers. Parallelize independent lint, typecheck, and test commands when useful. Only then start the tier-required reviewer.
7. Sol reconciles evidence, closes every ledger item, inspects current files and git diff, and runs `close`. Add the independent Sol verifier only for Q3.
8. Cite the accepted `.workflow/closure.json` in the final completion response. Worker consensus is evidence, not a vote.

## Performance policy

- Do not delegate a tiny task when worker startup costs more than doing it in the main Sol session.
- Batch related evidence into bounded worker tasks and reuse one run rather than creating many runs.
- Prefer Luna for mechanical speed, Terra for broad/context-heavy work, and additional Sol only for frontier reasoning or high-risk verification.
- Poll with short `status` or bounded `wait` calls; keep the main session responsive.
- Every worker runs on service tier `fast`, has lean isolated context, writes durable artifacts, and cannot spawn descendants. The fallback controller ignores unrelated user config, disables the remote plugin catalog so unused skill descriptions do not consume the worker context budget, forces `GPT56_ORCHESTRATOR_DISABLE=1` in worker runtimes to prevent recursive orchestration, and passes every required model, effort, sandbox, and tier setting explicitly.
- The main Sol session may open new workers as the task evolves, matching Claude Code Dynamic Workflows' lead-session plus dynamic-subagent pattern.

Hooks and process controls are workflow guardrails, not a security boundary. The live sandbox and permission policy remain authoritative.

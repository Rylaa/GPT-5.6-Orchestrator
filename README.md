# GPT-5.6 Orchestrator

### Sol Max leads the session. Luna, Terra, and Sol workers change with the task.

```text
+------------------------------------------------------------------+
|                    SOL MAX / MAIN SESSION                        |
|  understands -> decides -> assigns -> monitors -> accepts        |
+-------------------------------+----------------------------------+
                                |
                 DYNAMIC CODEX SUBAGENTS, ONLY AS NEEDED
             +------------------+------------------+
             v                  v                  v
      +-------------+    +-------------+    +-------------+
      | LUNA        |    | TERRA       |    | SOL         |
      | fast/exact  |    | broad/daily |    | critical    |
      +------+------+    +------+------+    +------+------+
             +------------------+------------------+
                                |
                     evidence returns to Sol
                                |
                tests or release proof -> Sol accepts
```

This is an Orchestrator, not a model fusion. GPT-5.6 Sol at `max` stays in the main interactive Codex session and controls the workflow. It dynamically opens bounded Luna, Terra, or additional Sol subagents, reads their evidence, makes every consequential decision, and owns the final answer.

Inspired by [Rylaa/fable5-orchestrator](https://github.com/Rylaa/fable5-orchestrator).

## Roles

```text
+--------------------------------+----------------+--------+-----------------+
| Worker                         | Model          | Effort | Default access  |
+--------------------------------+----------------+--------+-----------------+
| orchestrator_luna_gatherer     | gpt-5.6-luna   | low    | read-only       |
| orchestrator_luna_worker       | gpt-5.6-luna   | medium | workspace-write |
| orchestrator_luna_reviewer     | gpt-5.6-luna   | high   | read-only       |
| orchestrator_terra_explorer    | gpt-5.6-terra  | medium | read-only       |
| orchestrator_terra_worker      | gpt-5.6-terra  | high   | workspace-write |
| orchestrator_terra_reviewer    | gpt-5.6-terra  | high   | read-only       |
| orchestrator_sol_specialist    | gpt-5.6-sol    | max    | workspace-write |
| orchestrator_sol_verifier      | gpt-5.6-sol    | max    | read-only       |
+--------------------------------+----------------+--------+-----------------+
```

There is no worker judge. The Sol Max main session is the judge. Sol workers are bounded specialists or independent verifiers and return control to the main session.

## Quickstart

Install from a checkout registered in your personal Codex marketplace. The legacy package ID remains `codex-sol-fusion` so existing installations update in place; the product and skill are GPT-5.6 Orchestrator.

```sh
codex plugin add codex-sol-fusion@personal
codex -m gpt-5.6-sol -c 'model_reasoning_effort="max"' -c 'service_tier="fast"'
```

In that first session, open `/hooks`, inspect the plugin command hooks, and trust them. This one-time review is a Codex safety boundary; a changed hook is reviewed again after an update. Start a fresh Sol Max session after trust. From then on, every main-session prompt automatically enters the Orchestrator workflow; no invocation token is required.

Codex plugin installation does not run lifecycle scripts or rewrite `~/.codex/AGENTS.md`. The bundled trusted hook is the supported automatic activation path. To opt out of automatic activation, set `GPT56_ORCHESTRATOR_AUTO=0`; the exact token still enables one session explicitly:

```text
$gpt-5-6-orchestrator <your task>
```

## Dynamic workflow

The Sol main session uses the bundled controller. It creates one durable run, opens workers only when useful, and can inspect, wait for, or stop them at any time.

```sh
node scripts/orchestrator.mjs create --cwd "$PWD" --objective "audit and fix the target" --qa-tier q2
node scripts/orchestrator.mjs spawn --run <run-id> --worker scan --role orchestrator_terra_explorer --task-file .workflow/tasks/scan.md
node scripts/orchestrator.mjs test --run <run-id> --test-id unit -- npm test
node scripts/orchestrator.mjs release --run <run-id> --phase predeploy --remote origin --branch main -- <CI-status-command> <options> {sha}
node scripts/orchestrator.mjs release --run <run-id> --phase deploy --target <url> -- <deploy-command>
node scripts/orchestrator.mjs release --run <run-id> --phase smoke --target <url> -- <smoke-command>
node scripts/orchestrator.mjs status --run <run-id> --json
node scripts/orchestrator.mjs wait --run <run-id> --worker scan --timeout-seconds 30 --json
node scripts/orchestrator.mjs close --run <run-id> --sol-verdict accepted
node scripts/orchestrator.mjs stop --run <run-id> --worker scan
```

Write workers additionally require `--allow-write`. Task files must be regular non-symlink files inside the target repository. A run permits at most eight active workers.

## How it works

```text
+------+------------------------------------------------------------------+
| 1    | Sol Max reads the task and decides the first routing wave.       |
| 2    | It decomposes every request and asks on material ambiguity.       |
| 3    | Luna handles explicit, clear, repeatable lanes quickly.           |
| 4    | Terra handles broad scans and everyday judgment-heavy work.       |
| 5    | Critical deep implementation stays with main Sol or a Sol worker. |
| 6    | Writers finish and direct tests pass before reviewers start.      |
+------+------------------------------------------------------------------+
```

The main session can add subagents as evidence changes, like Claude Code Dynamic Workflows with a lead session and dynamic workers. Parallelism is limited to independent discovery or disjoint file ownership. Prompt length controls ledger policy, not model routing.

## Risk-based QA

```text
Q0  tiny/read-only       Sol inline self-check; no QA worker
Q1  bounded code         current test -> Luna checklist review
Q1  deploy-fast          exact-SHA CI -> deploy -> same-target smoke
Q2  cross-file/root cause current test -> Terra cross-file review
Q3  critical/high risk   current test -> Terra review -> Sol verifier
```

Sol selects the tier after clarification, records `QA-Tier: QN` in the ledger, and uses existing reviewers rather than an always-on QA agent. For deployment-only work whose clean local HEAD already equals a remote branch with green exact-SHA CI, `QA-Profile: deploy-fast` plus `--qa-profile deploy-fast` skips the duplicate local suite and reviewer. The predeploy command must take standalone `{sha}`, which is expanded to the verified commit. The provider-neutral `release` phases re-read the named remote and bind CI status, deployment, and post-deploy smoke to one SHA, workspace digest, target, and strict order; source or remote-SHA uncertainty falls back to standard Q1/Q2. The lightweight Stop hook runs no tests. It validates `.workflow/closure.json` and the matching private receipt only.

## Runtime proof

Each worker is a lean, isolated background `codex exec` subagent pinned to its exact model and effort on service tier `fast`. Unrelated user config is skipped, the remote plugin catalog is disabled to preserve the worker skill-context budget, automatic Orchestrator hooks are disabled inside worker runtimes, and required settings are passed explicitly. It records `events.jsonl`, `result.md`, `stderr.log`, and `proof.json`. Completion requires a non-empty Codex thread ID, a completed turn event, a zero exit code, and a non-empty result. Reviewer proof also requires a stable workspace. Process launch alone is never treated as success. No tmux or daemon is required.

On Codex CLI 0.144.4, the default direct collaboration schema cannot pin a named role, model, or effort from a Sol root. The bundled Codex subagent controller is the current exact-routing path; native subagents become preferable when the active schema can prove those pins. Generic unpinned children fail closed.

Managed access values are defaults; the live permission and sandbox policy can override them. Workers cannot spawn descendants or ask the user questions; ambiguity returns to main Sol. Trusted hooks activate automatically only on main-session prompts. Set `GPT56_ORCHESTRATOR_DISABLE=1` to disable all plugin hooks. Hooks and process controls are workflow reminders, not a security boundary.

## License

MIT. See [NOTICE](NOTICE).

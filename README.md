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
                    tests -> review -> Sol accepts
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
node scripts/manage-agent-profiles.mjs install
codex plugin add codex-sol-fusion@personal
codex -m gpt-5.6-sol -c 'model_reasoning_effort="max"' -c 'service_tier="fast"'
```

Inspect and trust the command hooks with `/hooks`, then run:

```text
$gpt-5-6-orchestrator <your task>
```

## Dynamic workflow

The Sol main session uses the bundled controller. It creates one durable run, opens workers only when useful, and can inspect, wait for, or stop them at any time.

```sh
node scripts/orchestrator.mjs create --cwd "$PWD" --objective "audit and fix the target"
node scripts/orchestrator.mjs spawn --run <run-id> --worker scan --role orchestrator_terra_explorer --task-file .workflow/tasks/scan.md
node scripts/orchestrator.mjs status --run <run-id> --json
node scripts/orchestrator.mjs wait --run <run-id> --worker scan --timeout-seconds 30 --json
node scripts/orchestrator.mjs stop --run <run-id> --worker scan
```

Write workers additionally require `--allow-write`. Task files must be regular non-symlink files inside the target repository. A run permits at most eight active workers.

## How it works

```text
+------+------------------------------------------------------------------+
| 1    | Sol Max reads the task and decides the first routing wave.       |
| 2    | Luna handles explicit, clear, repeatable lanes quickly.          |
| 3    | Terra handles broad scans and everyday judgment-heavy work.      |
| 4    | Critical deep implementation stays with main Sol or a Sol worker.|
| 5    | Writers finish and direct tests pass before reviewers start.     |
| 6    | Every worker returns proof and evidence; main Sol accepts or not. |
+------+------------------------------------------------------------------+
```

The main session can add subagents as evidence changes, like Claude Code Dynamic Workflows with a lead session and dynamic workers. Parallelism is limited to independent discovery or disjoint file ownership. Prompt length controls ledger policy, not model routing.

## Runtime proof

Each worker is a lean, isolated background `codex exec` subagent pinned to its exact model and effort on service tier `fast`. Unrelated user config is skipped; required runtime settings are passed explicitly. It records `events.jsonl`, `result.md`, `stderr.log`, and `proof.json`. Completion requires a non-empty Codex thread ID, a completed turn event, a zero exit code, and a non-empty result. Process launch alone is never treated as success. No tmux or daemon is required.

On Codex CLI 0.144.4, the default direct collaboration schema cannot pin a named role, model, or effort from a Sol root. The bundled Codex subagent controller is the current exact-routing path; native subagents become preferable when the active schema can prove those pins. Generic unpinned children fail closed.

Managed access values are defaults; the live permission and sandbox policy can override them. Workers cannot spawn descendants. Hooks and process controls are workflow reminders, not a security boundary, and globally discovered hooks remain inert until the exact `$gpt-5-6-orchestrator` token is used.

## License

MIT. See [NOTICE](NOTICE).

# Codex Sol Fusion

Codex Sol Fusion is a local Codex plugin that applies the orchestration ideas from [Rylaa/fable5-orchestrator](https://github.com/Rylaa/fable5-orchestrator) to Codex's native multi-agent and hook surfaces. Sol remains the chair and independent verifier; Luna handles bounded gathering, implementation, and routine review.

This is orchestration policy, not a model proxy. It does not launch hidden nested Codex sessions, and it does not turn hooks into a security boundary.

## What it adds

- An explicit `$codex-sol-fusion` skill with Sol and lean-Luna chair policies.
- Namespaced agent profiles with exact `gpt-5.6-sol` and `gpt-5.6-luna` pins.
- A `.workflow/LEDGER.md` contract for serious multi-step work.
- Fail-open hooks for proportional ledger reminders and safe worker handoff metadata.
- Event-only local metrics that never persist prompt text.

## Install

From this directory:

```sh
node scripts/manage-agent-profiles.mjs install
codex plugin add codex-sol-fusion@personal
```

Start a new Codex thread after installation. Codex requires explicit hook trust; inspect and enable this plugin's hooks from the hook management UI before expecting automatic injection. You can verify the role files at any time:

```sh
node scripts/manage-agent-profiles.mjs check
```

Invoke the plugin explicitly as `$codex-sol-fusion`. Plugin hooks are globally discovered after hook trust, but remain inert until that exact token activates Sol Fusion for the current session. Later turns in the same session keep the activation; unrelated Codex sessions are unaffected. Plain description matching is intentionally disabled so this skill does not compete with other multi-model workflows.

## Profiles

| Role | Model | Effort | Sandbox |
|---|---|---|---|
| `csf_luna_gatherer` | `gpt-5.6-luna` | low | read-only |
| `csf_luna_worker` | `gpt-5.6-luna` | max | workspace-write |
| `csf_luna_reviewer` | `gpt-5.6-luna` | high | read-only |
| `csf_sol_verifier` | `gpt-5.6-sol` | max | read-only |

Luna does not receive Sol-only `ultra` effort. Unknown chair models use a lean Luna instruction profile without falsely claiming a runtime model change.
The sandbox column is the role profile's default; an explicit parent-session permission policy can supersede it, so the chair must still verify effective permissions.

## Configuration

All settings are optional environment variables:

| Setting | Values | Default |
|---|---|---|
| `CODEX_SOL_FUSION_PROFILE` | `auto`, `sol`, `luna` | `auto` |
| `CODEX_SOL_FUSION_LEDGER_THRESHOLD` | 1–1,000,000 characters | profile default |
| `CODEX_SOL_FUSION_LEDGER_THRESHOLD_SOL` | 1–1,000,000 characters | 1500 |
| `CODEX_SOL_FUSION_LEDGER_THRESHOLD_LUNA` | 1–1,000,000 characters | 4000 |
| `CODEX_SOL_FUSION_METRICS` | `on`, `off` | `on` |
| `CODEX_SOL_FUSION_DISABLE` | `0`, `1` | `0` |

Runtime state is written beneath Codex's plugin data directory with hashed session identifiers, private permissions, bounded files, and atomic replacement. Raw prompts and assistant messages are not stored.

## Security and limits

- Codex validates the hook wire schema; the plugin additionally bounds common fields, checks event-specific fields, and handles failures open so a broken hook does not strand Codex.
- `SessionStart` and `Stop` are deliberately not registered: Codex 0.144 does not provide a reliable root-versus-child discriminator for those lifecycle hooks.
- Ledger labels are never copied into hook-added context; workers read them as untrusted repository data through normal tools.
- Pre-tool checks are workflow reminders and are not a security boundary. Codex's sandbox, approvals, and user authority remain authoritative.
- The hook manifest invokes only fixed local scripts through `${PLUGIN_ROOT}`. It never interpolates a model, effort, prompt, or repository value into a shell command.
- Agent-profile installation, checking, and removal reject symlinked directories and unmanaged collisions. Removal deletes only files carrying this plugin's marker.
- Hook trust is a user decision. Review `hooks/hooks.json` and the referenced script before enabling it.

## Development

```sh
npm test
npm run test:coverage
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

The implementation uses only Node.js standard-library modules. See `NOTICE` for source inspiration and licensing attribution.

To remove the model-pinned roles before uninstalling the plugin, run `node scripts/manage-agent-profiles.mjs remove`.

---
name: codex-sol-fusion
description: Use when the user explicitly requests Sol Fusion, Codex Sol/Luna orchestration, or a cost-quality split between GPT-5.6 Sol and Luna.
---

# Codex Sol Fusion

Run a host-native Codex workflow in which Sol owns judgment and Luna handles bounded work. Do not start hidden nested Codex processes. Agent model pins are exact only after the plugin's namespaced profiles have been installed.

The explicit `$codex-sol-fusion` token also activates this plugin's otherwise inert ledger hooks for the current session. Do not claim the hooks affect unrelated sessions.

## Routing

| Role | Agent | Model and effort | Use |
|---|---|---|---|
| Gatherer | `csf_luna_gatherer` | Luna, low | Narrow read-only evidence |
| Worker | `csf_luna_worker` | Luna, max | Isolated implementation and tests |
| Reviewer | `csf_luna_reviewer` | Luna, high | Routine read-only review |
| Verifier | `csf_sol_verifier` | Sol, max | Independent high-risk closure |

The invoking root agent is the chair. Use the Sol policy for an exact `gpt-5.6-sol` runtime; otherwise use the lean Luna policy without claiming that the runtime model changed. Lifecycle hooks are intentionally not used for chair injection because Codex cannot reliably distinguish root and child sessions there.

## Workflow

1. Convert serious, multi-step requirements into `.workflow/LEDGER.md` with stable checkboxes.
2. Keep planning, architecture, sensitive decisions, and acceptance with the chair.
3. Delegate independent, bounded items; give one worker ownership of each writable file area.
   Always spawn these specialized roles with `fork_turns: "none"`; include the assigned ledger IDs, boundaries, acceptance criteria, and required evidence in the task message instead of sharing the chair's full history.
4. Require this canonical five-field handoff: **Ledger items addressed and scope; Evidence and files changed; Verification result; Risks and unresolved issues; Confidence and out-of-scope findings.**
5. Store bulky intermediate artifacts in `.workflow/scratch/`.
6. Run tests and a routine review, then use `csf_sol_verifier` for independent closure when the risk warrants it.
7. Permit no more than three verification cycles. After three verification cycles, report unresolved ledger items instead of looping.

Mark a waived item only as `[~] deferred: reason`. Never mark an item complete from a worker's narration alone; verify the current artifact. Keep external actions within the user's explicit authority.

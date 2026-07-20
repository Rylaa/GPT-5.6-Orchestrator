import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const skillPath = 'skills/gpt-5-6-orchestrator/SKILL.md'
const metadataPath = 'skills/gpt-5-6-orchestrator/agents/openai.yaml'
const profiles = [
  'orchestrator-luna-gatherer.toml',
  'orchestrator-luna-worker.toml',
  'orchestrator-terra-explorer.toml',
  'orchestrator-terra-worker.toml',
  'orchestrator-sol-specialist.toml',
]

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}

test('manifest exposes the canonical GPT-5.6 Orchestrator identity', async () => {
  const manifest = JSON.parse(await read('.codex-plugin/plugin.json'))
  assert.equal(manifest.name, 'gpt-5-6-orchestrator')
  assert.match(manifest.version, /^0\.3\.0(?:\+codex\.\d{14})?$/)
  assert.equal(manifest.skills, './skills/')
  assert.equal(manifest.interface.displayName, 'GPT-5.6 Orchestrator')
  assert.deepEqual(manifest.interface.capabilities, ['Interactive', 'Read', 'Write'])
  assert.equal(Array.isArray(manifest.interface.defaultPrompt), true)
  assert.equal(manifest.interface.defaultPrompt.length <= 3, true)
  const prompt = manifest.interface.defaultPrompt.join(' ')
  assert.doesNotMatch(prompt, /\$gpt-5-6-orchestrator/)
  assert.match(prompt, /Sol.*configured reasoning target/i)
  assert.match(prompt, /decompose every request/i)
  assert.match(prompt, /clarify material ambiguity/i)
  assert.match(prompt, /dynamic/i)
  assert.doesNotMatch(prompt, /model fusion/i)
})

test('hook manifest uses PLUGIN_ROOT and points to the renamed handler', async () => {
  const hooks = JSON.parse(await read('hooks/hooks.json'))
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        assert.match(handler.command, /PLUGIN_ROOT/)
        assert.match(handler.command, /orchestrator-hook\.mjs/)
        const relativeScript = handler.command.match(/PLUGIN_ROOT}\/([^" ]+)/)?.[1]
        assert.ok(relativeScript)
        await access(path.join(root, relativeScript))
      }
    }
  }
  assert.ok(hooks.hooks.UserPromptSubmit)
  assert.ok(hooks.hooks.SessionStart)
  assert.ok(hooks.hooks.PostCompact)
  assert.ok(hooks.hooks.PreToolUse)
  assert.ok(hooks.hooks.Stop)
  assert.match(hooks.hooks.PreToolUse[0].matcher, /spawn_agent/)
  const handler = await read('lib/hook-handler.mjs')
  assert.match(handler, /\$gpt-5-6-orchestrator/)
  assert.match(handler, /native spawn surface cannot prove an exact named model and effort/i)
  assert.match(handler, /proof\.json/)
  assert.doesNotMatch(handler, /validateClosure|QA-Tier|deploy-fast/)
})

test('skill defines a Sol-main-session dynamic workflow', async () => {
  const skill = await read(skillPath)
  const metadata = await read(metadataPath)
  assert.match(skill, /^---\nname: gpt-5-6-orchestrator\n/)
  assert.match(skill, /Sol in the main interactive session at the configured reasoning target/i)
  assert.match(skill, /permanent chair/i)
  assert.match(skill, /bundled .*scripts\/orchestrator\.mjs.* controller/i)
  assert.match(skill, /background `codex exec` subagents/i)
  assert.match(skill, /dashboard.*--run/i)
  assert.match(skill, /pane.*--run/i)
  assert.match(skill, /optional.*tmux/i)
  assert.match(skill, /already inside tmux/i)
  assert.match(skill, /exact-pinned external workers/i)
  assert.match(skill, /native Codex subagents.*Desktop threads.*CLI `\/agent`.*IDE background-agent panel/is)
  assert.match(skill, /There is no worker judge/i)
  assert.match(skill, /main Sol session is the judge/i)
  assert.match(skill, /lead-session plus dynamic-worker pattern/i)
  assert.match(skill, /activates the workflow automatically for every main-session prompt/i)
  assert.match(skill, /Clarification gate/i)
  assert.match(skill, /Workers never ask the user/i)
  assert.match(skill, /\.workflow\/LEDGER\.md/)
  assert.match(skill, /\[~\] deferred: user-approved/i)
  assert.match(skill, /captures every worker's final response in private `report\.md`/i)
  assert.match(skill, /write workers may also use private `scratch`/i)
  assert.match(skill, /runtime proof establishes.*not semantic task success/i)
  assert.match(skill, /recursion-guard configuration/i)
  assert.match(skill, /at most three verify\/fix cycles/i)
  assert.match(skill, /active direct collaboration schema cannot select/i)
  assert.doesNotMatch(skill, /Luna root|Luna coordinator/i)
  assert.doesNotMatch(skill, /csf_/)
  for (const role of [
    'orchestrator_luna_gatherer',
    'orchestrator_terra_explorer',
    'orchestrator_terra_worker',
    'orchestrator_sol_specialist',
  ]) assert.match(skill, new RegExp(role))
  assert.doesNotMatch(skill, /Codex CLI \d/)
  assert.doesNotMatch(skill, /orchestrator_(?:luna|terra)_reviewer|orchestrator_sol_verifier/)
  assert.doesNotMatch(skill, /Q0|Q1|Q2|Q3|deploy-fast|closure\.json/)
  assert.doesNotMatch(metadata, /default_prompt:.*\$gpt-5-6-orchestrator/)
  assert.match(metadata, /allow_implicit_invocation:\s*true/)
})

test('worker profiles match task-shaped pins and return authority to main Sol', async () => {
  const contents = Object.fromEntries(await Promise.all(profiles.map(async (filename) => [
    filename,
    await read('agents/' + filename),
  ])))
  for (const [filename, profile] of Object.entries(contents)) {
    assert.match(profile, /^# Managed by gpt-5-6-orchestrator\./)
    assert.match(profile, /main Sol session/i)
    assert.match(profile, /ledger items addressed/i)
    assert.match(profile, /evidence and files/i)
    assert.match(profile, /verification result/i)
    assert.match(profile, /risks and unresolved/i)
    assert.match(profile, /confidence and out-of-scope/i)
    assert.match(profile, /do not spawn agents/i)
    assert.match(profile, /nickname_candidates\s*=\s*\[/)
    assert.match(profile, /\[agents\]\nmax_depth = 1/)
    assert.doesNotMatch(profile, /service_tier =/)
    if (filename.startsWith('orchestrator-sol-')) {
      assert.match(profile, /model = "gpt-5\.6-sol"/)
      assert.match(profile, /model_reasoning_effort = "high"/)
    } else {
      assert.match(profile, /model_reasoning_effort = "max"/)
    }
  }
  assert.match(contents['orchestrator-sol-specialist.toml'], /sandbox_mode = "workspace-write"/)
  const nicknames = profiles.flatMap((filename) => {
    const match = contents[filename].match(/nickname_candidates\s*=\s*\[([^\]]+)\]/)
    return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]) : []
  })
  assert.equal(nicknames.length, profiles.length * 3)
  assert.equal(new Set(nicknames).size, nicknames.length)
  await assert.rejects(() => access(path.join(root, 'agents', 'orchestrator-sol-judge.toml')))
  for (const retired of [
    'orchestrator-luna-reviewer.toml',
    'orchestrator-terra-reviewer.toml',
    'orchestrator-sol-verifier.toml',
  ]) await assert.rejects(() => access(path.join(root, 'agents', retired)))
})

test('README is concise and shows Sol controlling dynamic Codex subagents', async () => {
  const readme = await read('README.md')
  assert.equal(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(readme), true)
  assert.equal(readme.split('\n').length <= 175, true)
  assert.match(readme, /SOL \/ MAIN SESSION/)
  assert.match(readme, /DYNAMIC CODEX SUBAGENTS/)
  assert.match(readme, /This is a Codex-only Orchestrator, not a model fusion/i)
  assert.match(readme, /There is no worker judge/i)
  assert.match(readme, /\$gpt-5-6-orchestrator/)
  assert.match(readme, /Automatic activation applies to main-session prompts/i)
  assert.match(readme, /Codex plugin installation does not run lifecycle scripts/i)
  assert.match(readme, /codex -m gpt-5\.6-sol.*model_reasoning_effort/)
  assert.match(readme, /config --sol-effort high/)
  assert.match(readme, /manage-agent-profiles\.mjs install --sol-effort medium/)
  assert.match(readme, /Use `\/reasoning` for the current chat/i)
  assert.match(readme, /run-level.*--sol-effort.*GPT56_ORCHESTRATOR_SOL_EFFORT.*settings\.json.*high.*default/is)
  assert.match(readme, /node scripts\/orchestrator\.mjs spawn/)
  assert.match(readme, /proof\.json/)
  assert.match(readme, /dashboard --run/i)
  assert.match(readme, /pane --run/i)
  assert.match(readme, /already inside tmux/i)
  assert.match(readme, /exact-pinned external workers/i)
  assert.match(readme, /Desktop threads.*CLI `\/agent`.*IDE background-agent panel/is)
  assert.match(readme, /user-approved/i)
  assert.match(readme, /private `report\.md`.*private `scratch\/`/i)
  assert.match(readme, /runtime proof alone is not semantic success/i)
  assert.match(readme, /--owns/)
  assert.match(readme, /one writer may run.*Git workspace/i)
  assert.match(readme, /proof\.json.*schema v3/i)
  assert.match(readme, /Schema-v2 proofs remain readable/i)
  assert.match(readme, /hard timeout/i)
  assert.match(readme, /recoverable.*trash/i)
  assert.match(readme, /native multi-agent spawning disabled.*Orchestrator hooks disabled/i)
  assert.match(readme, /at most three verify\/fix cycles/i)
  assert.match(readme, /Rylaa\/fable5-orchestrator/)
  assert.match(readme, /not a security boundary/i)
  assert.match(readme, /tmux is optional/i)
  assert.doesNotMatch(readme, /Codex CLI \d/)
  assert.doesNotMatch(readme, /Q0|Q1|Q2|Q3|deploy-fast|closure\.json/)
  assert.doesNotMatch(readme, /LUNA \/ COORDINATE|Luna root only coordinates/i)
  assert.doesNotMatch(readme, /csf_/)
})

test('controller requires proof, bounded writes, and no descendants', async () => {
  const controller = await read('scripts/orchestrator.mjs')
  const policy = [await read(skillPath), await read('README.md'), controller].join('\n')
  assert.match(controller, /MAX_CONCURRENCY = 8/)
  assert.match(controller, /requires explicit --allow-write approval/i)
  assert.match(controller, /features\.multi_agent=false/)
  assert.match(controller, /GPT56_ORCHESTRATOR_DISABLE:\s*'1'/)
  assert.match(controller, /runtimeCompleted/)
  assert.match(controller, /recursionGuard/)
  assert.match(controller, /threadId/)
  assert.match(controller, /serviceTier: 'fast'/)
  assert.match(policy, /write workers run focused tests|focused tests.*return evidence/i)
  assert.match(policy, /prompt length controls ledger policy, not model routing/i)
  assert.match(policy, /do not silently substitute/i)
  assert.match(policy, /disjoint file ownership/i)
  assert.doesNotMatch(controller, /qaTier|qaProfile|runTestEvidence|runReleaseEvidence|closeRun|deploy-fast/)
  assert.doesNotMatch(controller, /test --run|release --run|close --run/)
})

test('source attribution and policy files contain no obvious secrets', async () => {
  const notice = await read('NOTICE')
  assert.match(notice, /GPT-5\.6 Orchestrator/)
  assert.match(notice, /fable5-orchestrator/i)
  const files = [
    '.codex-plugin/plugin.json',
    'README.md',
    'hooks/hooks.json',
    skillPath,
    'scripts/manage-agent-profiles.mjs',
    'scripts/orchestrator.mjs',
  ]
  const content = (await Promise.all(files.map(read))).join('\n')
  assert.doesNotMatch(content, /sk-[A-Za-z0-9_-]{20,}/)
  assert.doesNotMatch(content, /(?:api[_-]?key|token|password)\s*[:=]\s*["'][^"']+["']/i)
})

test('shipped runtime and documentation remain Codex-only', async () => {
  const shippedFiles = [
    '.codex-plugin/plugin.json',
    'README.md',
    'NOTICE',
    'hooks/hooks.json',
    'hooks/orchestrator-hook.mjs',
    'lib/hook-handler.mjs',
    'lib/routing.mjs',
    'scripts/orchestrator.mjs',
    skillPath,
    metadataPath,
  ]
  const content = (await Promise.all(shippedFiles.map(read))).join('\n')
  for (const providerName of ['Clau' + 'de', 'Anth' + 'ropic']) {
    assert.doesNotMatch(content, new RegExp(providerName, 'i'))
  }
  assert.match(content, /codex exec|codexBin|Codex-only/i)
})

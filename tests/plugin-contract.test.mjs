import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}

test('manifest exposes the intended plugin without unsupported hook wiring', async () => {
  const manifest = JSON.parse(await read('.codex-plugin/plugin.json'))
  assert.equal(manifest.name, 'codex-sol-fusion')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.skills, './skills/')
  assert.equal('hooks' in manifest, false)
  assert.deepEqual(manifest.interface.capabilities, ['Interactive', 'Read', 'Write'])
  assert.equal(Array.isArray(manifest.interface.defaultPrompt), true)
  assert.equal(manifest.interface.defaultPrompt.length <= 3, true)
})

test('default hook manifest uses PLUGIN_ROOT and points to real files', async () => {
  const hooks = JSON.parse(await read('hooks/hooks.json'))
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        assert.match(handler.command, /\$\{PLUGIN_ROOT\}/)
        const relativeScript = handler.command.match(/\$\{PLUGIN_ROOT\}\/([^" ]+)/)?.[1]
        assert.ok(relativeScript)
        await access(path.join(root, relativeScript))
      }
    }
  }
  assert.ok(hooks.hooks.UserPromptSubmit)
  assert.ok(hooks.hooks.PreToolUse)
  assert.ok(hooks.hooks.SubagentStart)
  assert.equal('SessionStart' in hooks.hooks, false)
  assert.equal('Stop' in hooks.hooks, false)
  assert.equal('SessionEnd' in hooks.hooks, false)
})

test('skill routing is explicit and does not collide with the existing slash fusion', async () => {
  const skill = await read('skills/codex-sol-fusion/SKILL.md')
  const metadata = await read('skills/codex-sol-fusion/agents/openai.yaml')
  assert.match(skill, /csf_luna_worker/)
  assert.match(skill, /csf_sol_verifier/)
  assert.match(skill, /\.workflow\/LEDGER\.md/)
  assert.match(skill, /three verification cycles/i)
  assert.doesNotMatch(skill, /\/fusion(?:\s|`|$)/)
  assert.match(metadata, /allow_implicit_invocation:\s*false/)
  const readme = await read('README.md')
  assert.match(readme, /\$codex-sol-fusion/)
})

test('all worker surfaces use one canonical five-field handoff', async () => {
  const surfaces = [
    await read('skills/codex-sol-fusion/SKILL.md'),
    await read('instructions/sol-chair.md'),
    await read('instructions/luna-chair.md'),
    await read('agents/csf-luna-gatherer.toml'),
    await read('agents/csf-luna-worker.toml'),
    await read('agents/csf-luna-reviewer.toml'),
    await read('agents/csf-sol-verifier.toml'),
  ]
  for (const surface of surfaces) {
    assert.match(surface, /ledger items addressed/i)
    assert.match(surface, /evidence and files/i)
    assert.match(surface, /verification result/i)
    assert.match(surface, /risks and unresolved/i)
    assert.match(surface, /confidence and out-of-scope/i)
  }
})

test('delegation requires isolated no-history forks', async () => {
  const surfaces = [
    await read('skills/codex-sol-fusion/SKILL.md'),
    await read('instructions/sol-chair.md'),
    await read('instructions/luna-chair.md'),
  ]
  for (const surface of surfaces) assert.match(surface, /fork_turns[^\n]*none/i)
})

test('source attribution and security boundaries are documented', async () => {
  const readme = await read('README.md')
  const notice = await read('NOTICE')
  assert.match(readme, /Rylaa\/fable5-orchestrator/)
  assert.match(readme, /not a security boundary/i)
  assert.match(readme, /hook trust/i)
  assert.match(readme, /globally discovered/i)
  assert.match(readme, /globally discovered[^\n]*remain inert/i)
  assert.match(readme, /\$codex-sol-fusion/)
  assert.match(notice, /fable5-orchestrator/i)
})

test('tracked text contains no obvious hardcoded secrets', async () => {
  const files = [
    '.codex-plugin/plugin.json',
    'README.md',
    'hooks/hooks.json',
    'skills/codex-sol-fusion/SKILL.md',
    'scripts/manage-agent-profiles.mjs',
  ]
  const content = (await Promise.all(files.map(read))).join('\n')
  assert.doesNotMatch(content, /sk-[A-Za-z0-9_-]{20,}/)
  assert.doesNotMatch(content, /(?:api[_-]?key|token|password)\s*[:=]\s*["'][^"']+["']/i)
})

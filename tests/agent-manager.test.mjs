import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AGENT_PROFILE_FILES,
  checkAgentProfiles,
  installAgentProfiles,
  LEGACY_AGENT_PROFILE_FILES,
  removeAgentProfiles,
} from '../scripts/manage-agent-profiles.mjs'

const pluginRoot = path.resolve(import.meta.dirname, '..')
const marker = '# Managed by gpt-5-6-orchestrator.'
const legacyMarker = '# Managed by codex-sol-fusion.'

async function makeCodexHome() {
  return mkdtemp(path.join(os.tmpdir(), 'g56o-home-'))
}

function runManager(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(pluginRoot, 'scripts', 'manage-agent-profiles.mjs'),
      ...args,
    ], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('installs task-shaped Luna, Terra, and Sol worker profiles without a worker judge', async () => {
  assert.deepEqual(AGENT_PROFILE_FILES, [
    'orchestrator-luna-gatherer.toml',
    'orchestrator-luna-worker.toml',
    'orchestrator-luna-reviewer.toml',
    'orchestrator-terra-explorer.toml',
    'orchestrator-terra-worker.toml',
    'orchestrator-terra-reviewer.toml',
    'orchestrator-sol-specialist.toml',
    'orchestrator-sol-verifier.toml',
  ])
  assert.equal(AGENT_PROFILE_FILES.some((name) => name.includes('judge')), false)
  const codexHome = await makeCodexHome()
  const result = await installAgentProfiles({ codexHome, pluginRoot })
  assert.equal(result.installed.length, AGENT_PROFILE_FILES.length)

  for (const filename of AGENT_PROFILE_FILES) {
    const profile = await readFile(path.join(codexHome, 'agents', filename), 'utf8')
    assert.ok(profile.startsWith(`${marker}\n`))
    assert.match(profile, /Sol Max main session/i)
    assert.match(profile, /\[agents\]\nmax_depth = 1/)
    assert.match(profile, /do not spawn agents/i)
    assert.doesNotMatch(profile, /service_tier =/)
    if (filename.startsWith('orchestrator-sol-')) {
      assert.match(profile, /model = "gpt-5\.6-sol"/)
      assert.match(profile, /model_reasoning_effort = "max"/)
    } else if (filename.startsWith('orchestrator-terra-')) {
      assert.match(profile, /model = "gpt-5\.6-terra"/)
    } else {
      assert.match(profile, /model = "gpt-5\.6-luna"/)
    }
  }
  assert.match(
    await readFile(path.join(codexHome, 'agents', 'orchestrator-sol-specialist.toml'), 'utf8'),
    /sandbox_mode = "workspace-write"/,
  )
  assert.match(
    await readFile(path.join(codexHome, 'agents', 'orchestrator-sol-verifier.toml'), 'utf8'),
    /sandbox_mode = "read-only"/,
  )
  assert.equal((await checkAgentProfiles({ codexHome, pluginRoot })).ok, true)
})

test('migrates only legacy profiles managed by the old package identity', async () => {
  const codexHome = await makeCodexHome()
  const agentsDir = path.join(codexHome, 'agents')
  await mkdir(agentsDir)
  for (const filename of LEGACY_AGENT_PROFILE_FILES) {
    await writeFile(path.join(agentsDir, filename), `${legacyMarker}\nname = "old"\n`)
  }
  const unmanagedLegacy = path.join(agentsDir, 'csf-luna-worker.toml')
  await writeFile(unmanagedLegacy, 'name = "mine"\n')

  const result = await installAgentProfiles({ codexHome, pluginRoot })
  assert.equal(result.removedLegacy.length, LEGACY_AGENT_PROFILE_FILES.length - 1)
  assert.deepEqual(result.skippedLegacy, ['csf-luna-worker.toml'])
  assert.equal(await readFile(unmanagedLegacy, 'utf8'), 'name = "mine"\n')
  assert.equal(result.installed.length, AGENT_PROFILE_FILES.length)
})

test('is idempotent and refuses to overwrite an unmanaged new profile', async () => {
  const codexHome = await makeCodexHome()
  await installAgentProfiles({ codexHome, pluginRoot })
  const second = await installAgentProfiles({ codexHome, pluginRoot })
  assert.equal(second.unchanged.length, AGENT_PROFILE_FILES.length)

  const conflictHome = await makeCodexHome()
  await mkdir(path.join(conflictHome, 'agents'))
  await writeFile(path.join(conflictHome, 'agents', AGENT_PROFILE_FILES[0]), 'name = "mine"\n')
  await assert.rejects(
    () => installAgentProfiles({ codexHome: conflictHome, pluginRoot }),
    /refusing to overwrite/i,
  )
})

test('reports changed and missing profiles, then repairs managed content', async () => {
  const codexHome = await makeCodexHome()
  await installAgentProfiles({ codexHome, pluginRoot })
  const changedName = AGENT_PROFILE_FILES[0]
  const missingName = AGENT_PROFILE_FILES[1]
  await writeFile(path.join(codexHome, 'agents', changedName), `${marker}\nname = "old"\n`)
  await unlink(path.join(codexHome, 'agents', missingName))
  const check = await checkAgentProfiles({ codexHome, pluginRoot })
  assert.equal(check.ok, false)
  assert.deepEqual(check.changed, [changedName])
  assert.deepEqual(check.missing, [missingName])

  const repaired = await installAgentProfiles({ codexHome, pluginRoot })
  assert.deepEqual(repaired.updated, [changedName])
  assert.deepEqual(repaired.installed, [missingName])
  assert.equal((await checkAgentProfiles({ codexHome, pluginRoot })).ok, true)
})

test('removes only managed new or legacy profiles and rejects symlink targets', async () => {
  const codexHome = await makeCodexHome()
  await installAgentProfiles({ codexHome, pluginRoot })
  const legacy = path.join(codexHome, 'agents', LEGACY_AGENT_PROFILE_FILES[0])
  await writeFile(legacy, `${legacyMarker}\nname = "legacy"\n`)
  const unmanaged = path.join(codexHome, 'agents', 'unmanaged.toml')
  await writeFile(unmanaged, 'name = "unmanaged"\n')
  const outside = path.join(codexHome, 'outside.toml')
  await writeFile(outside, `${marker}\n`)
  await unlink(path.join(codexHome, 'agents', AGENT_PROFILE_FILES[0]))
  await symlink(outside, path.join(codexHome, 'agents', AGENT_PROFILE_FILES[0]))

  const removed = await removeAgentProfiles({ codexHome })
  assert.equal(removed.removed.length, AGENT_PROFILE_FILES.length)
  assert.deepEqual(removed.skipped, [AGENT_PROFILE_FILES[0]])
  assert.equal(await readFile(unmanaged, 'utf8'), 'name = "unmanaged"\n')
})

test('CLI installs, checks, removes, and rejects malformed actions', async () => {
  const codexHome = await makeCodexHome()
  const install = await runManager(['install', '--codex-home', codexHome])
  assert.equal(install.code, 0)
  assert.equal(JSON.parse(install.stdout).installed.length, AGENT_PROFILE_FILES.length)

  const check = await runManager(['check'], { CODEX_HOME: codexHome })
  assert.equal(check.code, 0)
  assert.equal(JSON.parse(check.stdout).ok, true)

  const remove = await runManager(['remove', '--codex-home', codexHome])
  assert.equal(remove.code, 0)
  assert.equal(JSON.parse(remove.stdout).removed.length, AGENT_PROFILE_FILES.length)

  const unknown = await runManager(['explode', '--codex-home', codexHome])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /gpt-5-6-orchestrator: unknown action/i)

  const missingPath = await runManager(['check', '--codex-home'])
  assert.equal(missingPath.code, 1)
  assert.match(missingPath.stderr, /requires a path/i)
})

test('check and remove reject a symlinked agents directory', async () => {
  const codexHome = await makeCodexHome()
  const outside = await makeCodexHome()
  await symlink(outside, path.join(codexHome, 'agents'))
  await assert.rejects(() => checkAgentProfiles({ codexHome, pluginRoot }), /unsafe/i)
  await assert.rejects(() => removeAgentProfiles({ codexHome }), /unsafe/i)
})

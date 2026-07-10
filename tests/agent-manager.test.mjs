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
  removeAgentProfiles,
} from '../scripts/manage-agent-profiles.mjs'

const pluginRoot = path.resolve(import.meta.dirname, '..')

async function makeCodexHome() {
  return mkdtemp(path.join(os.tmpdir(), 'codex-sol-fusion-home-'))
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

test('installs namespaced Sol/Luna profiles with exact model pins', async () => {
  const codexHome = await makeCodexHome()
  const result = await installAgentProfiles({ codexHome, pluginRoot })
  assert.equal(result.installed.length, AGENT_PROFILE_FILES.length)

  const lunaWorker = await readFile(
    path.join(codexHome, 'agents', 'csf-luna-worker.toml'),
    'utf8',
  )
  const solVerifier = await readFile(
    path.join(codexHome, 'agents', 'csf-sol-verifier.toml'),
    'utf8',
  )
  assert.match(lunaWorker, /model = "gpt-5\.6-luna"/)
  assert.match(lunaWorker, /model_reasoning_effort = "max"/)
  assert.match(solVerifier, /model = "gpt-5\.6-sol"/)
  assert.doesNotMatch(lunaWorker, /ultra/)

  const check = await checkAgentProfiles({ codexHome, pluginRoot })
  assert.equal(check.ok, true)
  assert.equal(check.missing.length, 0)
})

test('is idempotent and refuses to overwrite an unmanaged profile', async () => {
  const codexHome = await makeCodexHome()
  await installAgentProfiles({ codexHome, pluginRoot })
  const second = await installAgentProfiles({ codexHome, pluginRoot })
  assert.equal(second.unchanged.length, AGENT_PROFILE_FILES.length)

  const conflictHome = await makeCodexHome()
  await mkdir(path.join(conflictHome, 'agents'))
  await writeFile(
    path.join(conflictHome, 'agents', 'csf-luna-worker.toml'),
    'name = "mine"\n',
  )
  await assert.rejects(
    () => installAgentProfiles({ codexHome: conflictHome, pluginRoot }),
    /refusing to overwrite/i,
  )
})

test('removes only profiles managed by this plugin', async () => {
  const codexHome = await makeCodexHome()
  await installAgentProfiles({ codexHome, pluginRoot })
  const unmanaged = path.join(codexHome, 'agents', 'unmanaged.toml')
  await writeFile(unmanaged, 'name = "unmanaged"\n')

  const removed = await removeAgentProfiles({ codexHome })
  assert.equal(removed.removed.length, AGENT_PROFILE_FILES.length)
  assert.equal(await readFile(unmanaged, 'utf8'), 'name = "unmanaged"\n')
})

test('reports and repairs missing or changed managed profiles', async () => {
  const codexHome = await makeCodexHome()
  await installAgentProfiles({ codexHome, pluginRoot })
  const changedName = 'csf-luna-gatherer.toml'
  const missingName = 'csf-luna-reviewer.toml'
  await writeFile(
    path.join(codexHome, 'agents', changedName),
    '# Managed by codex-sol-fusion.\nname = "old"\n',
  )
  await unlink(path.join(codexHome, 'agents', missingName))

  const check = await checkAgentProfiles({ codexHome, pluginRoot })
  assert.equal(check.ok, false)
  assert.deepEqual(check.changed, [changedName])
  assert.deepEqual(check.missing, [missingName])

  const repaired = await installAgentProfiles({ codexHome, pluginRoot })
  assert.deepEqual(repaired.updated, [changedName])
  assert.deepEqual(repaired.installed, [missingName])
})

test('rejects unsafe profile targets and invalid managed sources', async () => {
  const symlinkHome = await makeCodexHome()
  await mkdir(path.join(symlinkHome, 'agents'))
  const outside = path.join(symlinkHome, 'outside.toml')
  await writeFile(outside, 'outside\n')
  await symlink(outside, path.join(symlinkHome, 'agents', 'csf-luna-gatherer.toml'))
  await assert.rejects(
    () => installAgentProfiles({ codexHome: symlinkHome, pluginRoot }),
    /symlinked agent profile/i,
  )

  const directoryHome = await makeCodexHome()
  await mkdir(path.join(directoryHome, 'agents', 'csf-luna-gatherer.toml'), { recursive: true })
  await assert.rejects(
    () => installAgentProfiles({ codexHome: directoryHome, pluginRoot }),
    /non-file agent profile/i,
  )

  const badPluginRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-sol-fusion-plugin-'))
  await mkdir(path.join(badPluginRoot, 'agents'))
  await writeFile(path.join(badPluginRoot, 'agents', 'csf-luna-gatherer.toml'), 'name = "bad"\n')
  const badSourceHome = await makeCodexHome()
  await assert.rejects(
    () => installAgentProfiles({ codexHome: badSourceHome, pluginRoot: badPluginRoot }),
    /missing its managed marker/i,
  )
})

test('check and remove treat symlinked or unmanaged profiles as changed and skipped', async () => {
  const codexHome = await makeCodexHome()
  await mkdir(path.join(codexHome, 'agents'))
  const outside = path.join(codexHome, 'outside.toml')
  await writeFile(outside, '# Managed by codex-sol-fusion.\n')
  await symlink(outside, path.join(codexHome, 'agents', 'csf-luna-gatherer.toml'))
  await writeFile(path.join(codexHome, 'agents', 'csf-luna-worker.toml'), 'name = "mine"\n')

  const check = await checkAgentProfiles({ codexHome, pluginRoot })
  assert.equal(check.ok, false)
  assert.deepEqual(check.changed, ['csf-luna-gatherer.toml', 'csf-luna-worker.toml'])
  assert.equal(check.missing.length, 2)

  const removed = await removeAgentProfiles({ codexHome })
  assert.deepEqual(removed.removed, [])
  assert.deepEqual(removed.skipped, ['csf-luna-gatherer.toml', 'csf-luna-worker.toml'])
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
  assert.match(unknown.stderr, /unknown action/i)

  const missingPath = await runManager(['check', '--codex-home'])
  assert.equal(missingPath.code, 1)
  assert.match(missingPath.stderr, /requires a path/i)
})

test('check and remove reject a symlinked agents directory', async () => {
  const codexHome = await makeCodexHome()
  const outside = await makeCodexHome()
  await symlink(outside, path.join(codexHome, 'agents'))
  await assert.rejects(
    () => checkAgentProfiles({ codexHome, pluginRoot }),
    /unsafe codex agents directory/i,
  )
  await assert.rejects(
    () => removeAgentProfiles({ codexHome }),
    /unsafe codex agents directory/i,
  )
})

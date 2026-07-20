import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SOL_EFFORT,
  normalizeSolEffort,
  readOrchestratorSettings,
  SUPPORTED_SOL_EFFORTS,
  writeOrchestratorSettings,
} from '../lib/settings.mjs'

test('uses high by default and validates supported Sol efforts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-settings-'))
  assert.equal(DEFAULT_SOL_EFFORT, 'high')
  assert.deepEqual(SUPPORTED_SOL_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(normalizeSolEffort(' Medium '), 'medium')
  assert.throws(() => normalizeSolEffort('ultra'), /unsupported sol reasoning effort/i)
  assert.deepEqual(await readOrchestratorSettings(path.join(root, 'missing'), { env: {} }), {
    schemaVersion: 1,
    solEffort: 'high',
    source: 'default',
  })
})

test('persists private settings and lets an environment override win', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-settings-'))
  const written = await writeOrchestratorSettings(root, { solEffort: 'medium' })
  assert.equal(written.solEffort, 'medium')
  assert.equal((await lstat(root)).mode & 0o777, 0o700)
  assert.equal((await lstat(written.settingsPath)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(written.settingsPath, 'utf8')).solEffort, 'medium')
  assert.equal((await readOrchestratorSettings(root, { env: {} })).solEffort, 'medium')
  assert.deepEqual(await readOrchestratorSettings(root, {
    env: { GPT56_ORCHESTRATOR_SOL_EFFORT: 'xhigh' },
  }), {
    schemaVersion: 1,
    solEffort: 'xhigh',
    source: 'environment',
  })
})

test('rejects malformed, oversized, and symlinked settings surfaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-settings-'))
  const settingsPath = path.join(root, 'settings.json')
  await writeFile(settingsPath, '{broken')
  await assert.rejects(readOrchestratorSettings(root, { env: {} }), /JSON/)
  await writeFile(settingsPath, JSON.stringify({ schemaVersion: 2, solEffort: 'high' }))
  await assert.rejects(readOrchestratorSettings(root, { env: {} }), /settings schema/i)
  await writeFile(settingsPath, 'x'.repeat(64 * 1024 + 1))
  await assert.rejects(readOrchestratorSettings(root, { env: {} }), /bounded regular/i)

  const target = path.join(root, 'target.json')
  await writeFile(target, JSON.stringify({ schemaVersion: 1, solEffort: 'high' }))
  await writeFile(settingsPath, '{}')
  await unlink(settingsPath)
  await symlink(target, settingsPath)
  await assert.rejects(readOrchestratorSettings(root, { env: {} }), /bounded regular/i)
  await assert.rejects(writeOrchestratorSettings(root, { solEffort: 'high' }), /unsafe/i)

  const linkedData = path.join(path.dirname(root), `${path.basename(root)}-link`)
  await symlink(root, linkedData)
  await assert.rejects(readOrchestratorSettings(linkedData, { env: {} }), /unsafe/i)
  await assert.rejects(writeOrchestratorSettings(linkedData, { solEffort: 'high' }), /unsafe/i)

  const regularData = path.join(root, 'regular-data')
  await writeFile(regularData, 'not a directory')
  await assert.rejects(writeOrchestratorSettings(regularData, { solEffort: 'high' }), /unsafe/i)
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  appendMetric,
  getSessionStatePath,
  readSessionState,
  writeSessionState,
} from '../lib/state.mjs'

async function makeDataDir() {
  return mkdtemp(path.join(os.tmpdir(), 'gpt-5-6-orchestrator-state-'))
}

test('hashes session ids and writes private atomic state files', async () => {
  const dataDir = await makeDataDir()
  const sessionId = '../../private/session'
  const statePath = getSessionStatePath(dataDir, sessionId)
  assert.equal(statePath.includes('..'), false)
  assert.equal(statePath.includes('private'), false)

  await writeSessionState(dataDir, sessionId, {
    schemaVersion: 1,
    profile: 'sol',
    startedAtMs: 100,
  })
  assert.deepEqual(await readSessionState(dataDir, sessionId), {
    schemaVersion: 1,
    profile: 'sol',
    startedAtMs: 100,
  })
  const mode = (await stat(statePath)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('metrics keep event metadata but reject raw prompt-like fields', async () => {
  const dataDir = await makeDataDir()
  await appendMetric(dataDir, {
    event: 'profile_injected',
    profile: 'sol',
    prompt: 'must never be persisted',
    arbitrary: 'drop me',
  })
  const metrics = await readFile(path.join(dataDir, 'metrics.jsonl'), 'utf8')
  const event = JSON.parse(metrics.trim())
  assert.equal(event.event, 'profile_injected')
  assert.equal(event.profile, 'sol')
  assert.equal('prompt' in event, false)
  assert.equal('arbitrary' in event, false)
})

test('invalid or missing state is treated as absent', async () => {
  const dataDir = await makeDataDir()
  assert.equal(await readSessionState(dataDir, 'missing'), null)
  const statePath = getSessionStatePath(dataDir, 'broken')
  await writeSessionState(dataDir, 'broken', { valid: true })
  await writeFile(statePath, '{broken')
  assert.equal(await readSessionState(dataDir, 'broken'), null)
  await writeFile(statePath, '[]')
  assert.equal(await readSessionState(dataDir, 'broken'), null)
})

test('metrics reject symlinked files and data directories', async () => {
  const dataDir = await makeDataDir()
  const outsideFile = path.join(await makeDataDir(), 'outside.txt')
  await writeFile(outsideFile, 'unchanged\n')
  await symlink(outsideFile, path.join(dataDir, 'metrics.jsonl'))
  await assert.rejects(
    () => appendMetric(dataDir, { event: 'must_not_escape' }),
    /symlink|regular file|unsafe/i,
  )
  assert.equal(await readFile(outsideFile, 'utf8'), 'unchanged\n')

  const parent = await makeDataDir()
  const outsideDir = await makeDataDir()
  const linkedDataDir = path.join(parent, 'linked-data')
  await symlink(outsideDir, linkedDataDir)
  await assert.rejects(
    () => appendMetric(linkedDataDir, { event: 'must_not_escape' }),
    /symlink|unsafe/i,
  )
})

test('session state rejects a symlinked plugin data directory', async () => {
  const parent = await makeDataDir()
  const outsideDir = await makeDataDir()
  const linkedDataDir = path.join(parent, 'linked-state')
  await symlink(outsideDir, linkedDataDir)
  await assert.rejects(
    () => writeSessionState(linkedDataDir, 'session', { schemaVersion: 1 }),
    /symlink|unsafe/i,
  )
})

test('session state reads reject symlinked data and state files', async () => {
  const parent = await makeDataDir()
  const outsideDir = await makeDataDir()
  await writeSessionState(outsideDir, 'session', { schemaVersion: 1, active: true })
  const linkedDataDir = path.join(parent, 'linked-read')
  await symlink(outsideDir, linkedDataDir)
  await assert.rejects(
    () => readSessionState(linkedDataDir, 'session'),
    /symlink|unsafe/i,
  )

  const dataDir = await makeDataDir()
  await writeSessionState(dataDir, 'state-link', { schemaVersion: 1 })
  const statePath = getSessionStatePath(dataDir, 'state-link')
  const outsideState = path.join(await makeDataDir(), 'outside.json')
  await writeFile(outsideState, '{"schemaVersion":1,"active":true}\n')
  await unlink(statePath)
  await symlink(outsideState, statePath)
  await assert.rejects(
    () => readSessionState(dataDir, 'state-link'),
    /symlink|regular file|unsafe/i,
  )
})

test('session state reads reject files larger than the one MiB limit', async () => {
  const dataDir = await makeDataDir()
  const sessionId = 'oversized-state'
  await writeSessionState(dataDir, sessionId, { schemaVersion: 1 })
  await writeFile(getSessionStatePath(dataDir, sessionId), 'x'.repeat(1024 * 1024 + 1))

  await assert.rejects(
    () => readSessionState(dataDir, sessionId),
    /bounded regular file/i,
  )
})

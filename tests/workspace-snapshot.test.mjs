import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  captureWorkspaceSnapshot,
  validateSnapshotOwnership,
} from '../lib/workspace-snapshot.mjs'

const execFileAsync = promisify(execFile)

async function workspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'g56o-snapshot-'))
  await execFileAsync('git', ['init', '-q', cwd])
  await mkdir(path.join(cwd, 'src'))
  await writeFile(path.join(cwd, 'src', 'owned.js'), 'one\n')
  await writeFile(path.join(cwd, 'outside.js'), 'outside\n')
  return cwd
}

test('detects changes against dirty baselines and enforces owned paths', async () => {
  const cwd = await workspace()
  const before = await captureWorkspaceSnapshot({ cwd })
  await writeFile(path.join(cwd, 'src', 'owned.js'), 'two\n')
  const owned = validateSnapshotOwnership({
    before,
    after: await captureWorkspaceSnapshot({ cwd }),
    owns: ['src'],
  })
  assert.equal(owned.valid, true)
  assert.deepEqual(owned.changedPaths, ['src/owned.js'])

  await writeFile(path.join(cwd, 'outside.js'), 'escaped\n')
  const escaped = validateSnapshotOwnership({
    before,
    after: await captureWorkspaceSnapshot({ cwd }),
    owns: ['src'],
  })
  assert.equal(escaped.valid, false)
  assert.deepEqual(escaped.outsidePaths, ['outside.js'])
})

test('requires a Git worktree for write-proof snapshots', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'g56o-not-git-'))
  await assert.rejects(() => captureWorkspaceSnapshot({ cwd }), /require a Git worktree/i)
})

test('uses Git-root paths correctly when the worker cwd is a nested directory', async () => {
  const root = await workspace()
  const cwd = path.join(root, 'src')
  const before = await captureWorkspaceSnapshot({ cwd })
  assert.deepEqual(Object.keys(before.entries), ['owned.js'])
  assert.equal(before.gitRoot, await realpath(root))

  await writeFile(path.join(cwd, 'owned.js'), 'nested change\n')
  const result = validateSnapshotOwnership({
    before,
    after: await captureWorkspaceSnapshot({ cwd }),
    owns: ['owned.js'],
  })
  assert.equal(result.valid, true)
  assert.deepEqual(result.changedPaths, ['owned.js'])
})

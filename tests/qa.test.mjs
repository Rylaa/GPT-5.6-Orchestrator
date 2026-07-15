import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  claimsTaskCompletion,
  normalizeQaTier,
  QA_TIERS,
  validateClosure,
  validateTestProofPath,
  validateWorkerProofPath,
  workspaceDigest,
} from '../lib/qa.mjs'

const execFileAsync = promisify(execFile)

test('defines risk-shaped QA tiers and detects only strong completion claims', () => {
  assert.deepEqual(QA_TIERS.q0.reviewRoles, [])
  assert.deepEqual(QA_TIERS.q1.reviewRoles, ['orchestrator_luna_reviewer'])
  assert.deepEqual(QA_TIERS.q2.reviewRoles, ['orchestrator_terra_reviewer'])
  assert.deepEqual(QA_TIERS.q3.reviewRoles, [
    'orchestrator_terra_reviewer',
    'orchestrator_sol_verifier',
  ])
  assert.equal(normalizeQaTier('Q2'), 'q2')
  assert.throws(() => normalizeQaTier('q9'), /q0, q1, q2, or q3/i)
  for (const message of [
    'Done. The implementation is ready.',
    'The plugin implementation has been completed.',
    'Değişikliği tamamladım.',
    'Güncelledim ve GitHuba gönderdim.',
    'Updated. The plugin now enforces QA.',
    'QA closure: .workflow/closure.json',
  ]) assert.equal(claimsTaskCompletion(message), true)
  for (const message of [
    'The implementation is not complete yet.',
    'Henüz tamamlanmadı; test bekliyor.',
    'Tests completed, but I am still reviewing the implementation.',
    'Updated code, but I am still reviewing the implementation.',
    'I need one clarification before proceeding.',
  ]) assert.equal(claimsTaskCompletion(message), false)
})

test('non-git digest ignores workflow metadata but changes with deliverable files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-qa-files-'))
  await mkdir(path.join(root, '.workflow'))
  await writeFile(path.join(root, 'app.js'), 'export const value = 1\n')
  const original = await workspaceDigest(root)
  await writeFile(path.join(root, '.workflow', 'LEDGER.md'), 'QA-Tier: Q0\n- [x] done\n')
  assert.equal(await workspaceDigest(root), original)
  await writeFile(path.join(root, 'app.js'), 'export const value = 2\n')
  assert.notEqual(await workspaceDigest(root), original)
})

test('git digest stays stable across commits and ignores workflow metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-qa-git-'))
  await execFileAsync('git', ['init', '-q', root])
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'qa@example.invalid'])
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'QA Test'])
  await writeFile(path.join(root, 'app.js'), 'export const value = 1\n')
  await execFileAsync('git', ['-C', root, 'add', 'app.js'])
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'initial'])
  const original = await workspaceDigest(root)

  await writeFile(path.join(root, 'app.js'), 'export const value = 2\n')
  const changed = await workspaceDigest(root)
  assert.notEqual(changed, original)
  await execFileAsync('git', ['-C', root, 'add', 'app.js'])
  await execFileAsync('git', ['-C', root, 'commit', '-qm', 'change'])
  assert.equal(await workspaceDigest(root), changed)

  await mkdir(path.join(root, '.workflow'))
  await writeFile(path.join(root, '.workflow', 'closure.json'), '{}\n')
  assert.equal(await workspaceDigest(root), changed)
})

test('rejects direct and closure proof paths with symlinked ancestors', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'g56o-qa-symlink-workspace-'))
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'g56o-qa-symlink-data-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'g56o-qa-symlink-outside-'))
  const runId = 'escape-run'
  const runRoot = path.join(dataDir, 'runs', runId)
  await mkdir(runRoot, { recursive: true })
  await writeFile(path.join(cwd, 'app.js'), 'export const safe = true\n')
  const digest = await workspaceDigest(cwd)
  await writeFile(path.join(runRoot, 'run.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    cwd,
    qaTier: 'q1',
    controller: { model: 'gpt-5.6-sol' },
  }))

  const testRoot = path.join(outside, 'tests')
  const testProofPath = path.join(testRoot, 'unit', 'proof.json')
  await mkdir(path.dirname(testProofPath), { recursive: true })
  await writeFile(testProofPath, JSON.stringify({
    schemaVersion: 1,
    status: 'passed',
    runId,
    testId: 'unit',
    command: ['true'],
    exitCode: 0,
    workspaceDigestStarted: digest,
    workspaceDigest: digest,
    startedAt: '2026-07-14T00:00:00.000Z',
    completedAt: '2026-07-14T00:00:01.000Z',
  }))
  await symlink(testRoot, path.join(runRoot, 'tests'))

  const workerRoot = path.join(outside, 'workers')
  const workerProofPath = path.join(workerRoot, 'review', 'proof.json')
  await mkdir(path.dirname(workerProofPath), { recursive: true })
  await writeFile(workerProofPath, JSON.stringify({
    schemaVersion: 1,
    status: 'completed',
    runId,
    workerId: 'review',
    role: 'orchestrator_luna_reviewer',
    model: 'gpt-5.6-luna',
    effort: 'high',
    sandbox: 'read-only',
    serviceTier: 'fast',
    threadId: 'thread-symlink-test',
    runtimeCompleted: true,
    exitCode: 0,
    workspaceDigestStarted: digest,
    workspaceDigest: digest,
    startedAt: '2026-07-14T00:00:02.000Z',
    completedAt: '2026-07-14T00:00:03.000Z',
  }))
  await symlink(workerRoot, path.join(runRoot, 'workers'))

  const testResult = await validateTestProofPath({
    proofPath: path.join(runRoot, 'tests', 'unit', 'proof.json'),
    cwd,
    dataDir,
    expectedDigest: digest,
    expectedRunId: runId,
  })
  assert.equal(testResult.valid, false)
  assert.match(testResult.reason, /symlink|trusted root|outside/i)

  const workerResult = await validateWorkerProofPath({
    proofPath: path.join(runRoot, 'workers', 'review', 'proof.json'),
    cwd,
    dataDir,
    expectedDigest: digest,
    expectedRunId: runId,
    requireStable: true,
  })
  assert.equal(workerResult.valid, false)
  assert.match(workerResult.reason, /symlink|trusted root|outside/i)

  await mkdir(path.join(cwd, '.workflow'))
  await writeFile(path.join(cwd, '.workflow', 'LEDGER.md'), 'QA-Tier: Q1\n- [x] secure proof paths\n')
  const closurePayload = {
    schemaVersion: 1,
    status: 'accepted',
    runId,
    qaTier: 'q1',
    workspaceDigest: digest,
    ledger: { totalItems: 1, closedItems: 1 },
    tests: [path.join(runRoot, 'tests', 'unit', 'proof.json')],
    reviews: [path.join(runRoot, 'workers', 'review', 'proof.json')],
    solVerdict: 'accepted',
  }
  await writeFile(path.join(runRoot, 'closure-receipt.json'), JSON.stringify(closurePayload))
  await writeFile(path.join(cwd, '.workflow', 'closure.json'), JSON.stringify(closurePayload))
  const closure = await validateClosure({ cwd, dataDir })
  assert.equal(closure.valid, false)
  assert.match(closure.reason, /symlink|trusted root|outside/i)
})

test('rejects a workspace closure without a private controller receipt', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'g56o-qa-forged-workspace-'))
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'g56o-qa-forged-data-'))
  const runId = 'forged-run'
  const runRoot = path.join(dataDir, 'runs', runId)
  await mkdir(runRoot, { recursive: true })
  await mkdir(path.join(cwd, '.workflow'))
  await writeFile(path.join(cwd, 'app.js'), 'export const safe = true\n')
  await writeFile(path.join(cwd, '.workflow', 'LEDGER.md'), 'QA-Tier: Q0\n- [x] accepted\n')
  const digest = await workspaceDigest(cwd)
  await writeFile(path.join(runRoot, 'run.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    cwd,
    qaTier: 'q0',
    controller: { model: 'gpt-5.6-sol' },
  }))
  const forgedClosure = {
    schemaVersion: 1,
    status: 'accepted',
    runId,
    qaTier: 'q0',
    workspaceDigest: digest,
    ledger: { totalItems: 1, closedItems: 1 },
    tests: [],
    reviews: [],
    solVerdict: 'accepted',
  }
  await writeFile(path.join(cwd, '.workflow', 'closure.json'), JSON.stringify(forgedClosure))
  const closure = await validateClosure({ cwd, dataDir })
  assert.equal(closure.valid, false)
  assert.match(closure.reason, /receipt|could not be validated|ENOENT/i)

  await writeFile(path.join(runRoot, 'closure-receipt.json'), JSON.stringify({
    ...forgedClosure,
    createdAt: '2026-07-14T00:00:00.000Z',
  }))
  const mismatched = await validateClosure({ cwd, dataDir })
  assert.equal(mismatched.valid, false)
  assert.match(mismatched.reason, /does not match.*private controller receipt/i)
})

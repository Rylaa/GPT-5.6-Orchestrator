import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertContainedPath,
  readContainedBoundedJson,
  validateWorkerProofPath,
} from '../lib/proof.mjs'
import { HANDOFF_FIELDS } from '../lib/task-contract.mjs'

const REPORT = [
  '1. Ledger items addressed and scope: F1 proof validation.',
  '2. Evidence and files changed: no repository files.',
  '3. Verification result: passed.',
  '4. Risks and unresolved issues: none.',
  '5. Confidence and out-of-scope findings: high; none.',
  '',
].join('\n')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function makeProofFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-proof-'))
  const cwd = path.join(root, 'repo')
  const dataDir = path.join(root, 'data')
  const runId = 'proof-run'
  const workerId = 'proof-worker'
  const workerRoot = path.join(dataDir, 'runs', runId, 'workers', workerId)
  const proofPath = path.join(workerRoot, 'proof.json')
  const reportPath = path.join(workerRoot, 'report.md')
  await mkdir(path.join(workerRoot, 'scratch'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(reportPath, REPORT)
  const digest = createHash('sha256').update(REPORT).digest('hex')
  const proof = {
    schemaVersion: 3,
    status: 'completed',
    runId,
    workerId,
    role: 'orchestrator_luna_gatherer',
    backend: 'codex-exec-background',
    model: 'gpt-5.6-luna',
    effort: 'max',
    sandbox: 'read-only',
    serviceTier: 'fast',
    threadId: 'thread-proof',
    runtimeCompleted: true,
    recursionGuard: {
      multiAgentDisabled: true,
      pluginsDisabled: true,
      orchestratorHooksDisabled: true,
    },
    exitCode: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    taskPath: path.join(workerRoot, 'task.md'),
    scratchPath: path.join(workerRoot, 'scratch'),
    reportPath,
    resultPath: reportPath,
    eventsPath: path.join(workerRoot, 'events.jsonl'),
    stderrPath: path.join(workerRoot, 'stderr.log'),
    baselinePath: null,
    launchContract: {
      source: 'controller-cli-request',
      model: 'gpt-5.6-luna',
      effort: 'max',
      serviceTier: 'fast',
      sandbox: 'read-only',
    },
    runtimeEvidence: {
      source: 'codex-json-events',
      lifecycleValid: true,
      threadStartCount: 1,
      completionCount: 1,
      malformedLines: 0,
      modelObserved: false,
      effortObserved: false,
    },
    reportContract: {
      valid: true,
      fields: [...HANDOFF_FIELDS],
      size: Buffer.byteLength(REPORT),
      sha256: digest,
    },
    ownership: { valid: true },
  }
  const worker = {
    schemaVersion: 2,
    runId,
    workerId,
    role: proof.role,
    model: proof.model,
    effort: proof.effort,
    sandbox: proof.sandbox,
    status: 'completed',
    proofPath,
    threadId: proof.threadId,
  }
  const run = {
    schemaVersion: 2,
    runId,
    cwd,
    controller: {
      model: 'gpt-5.6-sol',
      effort: 'max',
      authority: 'main-session',
      attestation: 'declared-main-session-contract',
    },
    workerBackend: 'codex-exec-background',
  }
  const writeProof = (value = proof) => writeFile(proofPath, JSON.stringify(value))
  const writeWorker = (value = worker) => writeFile(path.join(workerRoot, 'worker.json'), JSON.stringify(value))
  const writeRun = (value = run) => writeFile(path.join(dataDir, 'runs', runId, 'run.json'), JSON.stringify(value))
  await Promise.all([writeProof(), writeWorker(), writeRun()])
  return {
    cwd,
    dataDir,
    runId,
    workerId,
    workerRoot,
    proofPath,
    reportPath,
    proof,
    worker,
    run,
    writeProof,
    writeWorker,
    writeRun,
  }
}

async function validate(fixture, overrides = {}) {
  return validateWorkerProofPath({
    proofPath: fixture.proofPath,
    cwd: fixture.cwd,
    dataDir: fixture.dataDir,
    expectedRunId: fixture.runId,
    ...overrides,
  })
}

test('accepts schema-v3 proof and retains schema-v2 compatibility', async () => {
  const fixture = await makeProofFixture()
  assert.equal((await validate(fixture)).valid, true)

  const legacy = clone(fixture.proof)
  legacy.schemaVersion = 2
  delete legacy.launchContract
  delete legacy.runtimeEvidence
  delete legacy.reportContract
  delete legacy.ownership
  delete legacy.baselinePath
  await fixture.writeProof(legacy)
  assert.equal((await validate(fixture)).valid, true)
})

test('rejects forged proof identity, placement, handoff paths, and roles', async () => {
  const identityCases = [
    ['schema', (proof) => { proof.schemaVersion = 1 }],
    ['run identifier', (proof) => { proof.runId = '!bad' }],
    ['worker identifier', (proof) => { proof.workerId = '!bad' }],
  ]
  for (const [label, mutate] of identityCases) {
    const fixture = await makeProofFixture()
    const proof = clone(fixture.proof)
    mutate(proof)
    await fixture.writeProof(proof)
    assert.match((await validate(fixture)).reason, /identity/i, label)
  }

  const mismatch = await makeProofFixture()
  assert.match((await validate(mismatch, { expectedRunId: 'another-run' })).reason, /identity/i)

  const unmanaged = await makeProofFixture()
  const unmanagedProof = clone(unmanaged.proof)
  unmanagedProof.role = 'unknown-worker'
  await unmanaged.writeProof(unmanagedProof)
  assert.match((await validate(unmanaged)).reason, /unmanaged role/i)

  const misplaced = await makeProofFixture()
  const otherRoot = path.join(misplaced.dataDir, 'runs', misplaced.runId, 'workers', 'other-worker')
  await mkdir(otherRoot, { recursive: true })
  const otherPath = path.join(otherRoot, 'proof.json')
  await writeFile(otherPath, JSON.stringify(misplaced.proof))
  assert.match((await validate(misplaced, { proofPath: otherPath })).reason, /path does not match/i)

  const badHandoff = await makeProofFixture()
  const badHandoffProof = clone(badHandoff.proof)
  badHandoffProof.eventsPath = path.join(badHandoff.workerRoot, 'different-events.jsonl')
  await badHandoff.writeProof(badHandoffProof)
  assert.match((await validate(badHandoff)).reason, /handoff paths/i)

  const outside = await makeProofFixture()
  const outsidePath = path.join(path.dirname(outside.dataDir), 'outside-proof.json')
  await writeFile(outsidePath, '{}')
  assert.match((await validate(outside, { proofPath: outsidePath })).reason, /outside the runs/i)
})

test('rejects every incomplete runtime-contract dimension', async () => {
  const cases = [
    ['status', (proof) => { proof.status = 'failed' }],
    ['backend', (proof) => { proof.backend = 'native' }],
    ['model', (proof) => { proof.model = 'gpt-5.6-terra' }],
    ['effort', (proof) => { proof.effort = 'low' }],
    ['sandbox', (proof) => { proof.sandbox = 'workspace-write' }],
    ['tier', (proof) => { proof.serviceTier = 'standard' }],
    ['thread type', (proof) => { proof.threadId = 7 }],
    ['thread empty', (proof) => { proof.threadId = '' }],
    ['completion', (proof) => { proof.runtimeCompleted = false }],
    ['multi-agent guard', (proof) => { proof.recursionGuard.multiAgentDisabled = false }],
    ['plugin guard', (proof) => { proof.recursionGuard.pluginsDisabled = false }],
    ['hook guard', (proof) => { proof.recursionGuard.orchestratorHooksDisabled = false }],
    ['exit', (proof) => { proof.exitCode = 1 }],
    ['start time', (proof) => { proof.startedAt = 'invalid' }],
    ['completion time', (proof) => { proof.completedAt = '2025-01-01T00:00:00.000Z' }],
  ]
  for (const [label, mutate] of cases) {
    const fixture = await makeProofFixture()
    const proof = clone(fixture.proof)
    mutate(proof)
    await fixture.writeProof(proof)
    assert.match((await validate(fixture)).reason, /runtime contract/i, label)
  }
})

test('rejects every incomplete schema-v3 evidence dimension', async () => {
  const cases = [
    ['launch source', (proof) => { proof.launchContract.source = 'worker' }],
    ['launch model', (proof) => { proof.launchContract.model = 'gpt-5.6-terra' }],
    ['launch effort', (proof) => { proof.launchContract.effort = 'low' }],
    ['launch tier', (proof) => { proof.launchContract.serviceTier = 'standard' }],
    ['launch sandbox', (proof) => { proof.launchContract.sandbox = 'workspace-write' }],
    ['runtime source', (proof) => { proof.runtimeEvidence.source = 'self-report' }],
    ['runtime lifecycle', (proof) => { proof.runtimeEvidence.lifecycleValid = false }],
    ['thread count', (proof) => { proof.runtimeEvidence.threadStartCount = 2 }],
    ['completion count', (proof) => { proof.runtimeEvidence.completionCount = 2 }],
    ['malformed lines', (proof) => { proof.runtimeEvidence.malformedLines = 1 }],
    ['model observation', (proof) => { proof.runtimeEvidence.modelObserved = true }],
    ['effort observation', (proof) => { proof.runtimeEvidence.effortObserved = true }],
    ['report validity', (proof) => { proof.reportContract.valid = false }],
    ['report fields', (proof) => { proof.reportContract.fields = HANDOFF_FIELDS.slice(0, -1) }],
    ['ownership', (proof) => { proof.ownership.valid = false }],
  ]
  for (const [label, mutate] of cases) {
    const fixture = await makeProofFixture()
    const proof = clone(fixture.proof)
    mutate(proof)
    await fixture.writeProof(proof)
    assert.match((await validate(fixture)).reason, /v3 evidence contract/i, label)
  }
})

test('binds schema-v3 proof to the completed worker record', async () => {
  const cases = [
    ['run', (worker) => { worker.runId = 'other-run' }],
    ['worker', (worker) => { worker.workerId = 'other-worker' }],
    ['role', (worker) => { worker.role = 'orchestrator_terra_explorer' }],
    ['model', (worker) => { worker.model = 'gpt-5.6-terra' }],
    ['effort', (worker) => { worker.effort = 'low' }],
    ['sandbox', (worker) => { worker.sandbox = 'workspace-write' }],
    ['status', (worker) => { worker.status = 'running' }],
    ['proof path', (worker) => { worker.proofPath += '.other' }],
    ['thread', (worker) => { worker.threadId = 'other-thread' }],
  ]
  for (const [label, mutate] of cases) {
    const fixture = await makeProofFixture()
    const worker = clone(fixture.worker)
    mutate(worker)
    await fixture.writeWorker(worker)
    assert.match((await validate(fixture)).reason, /completed worker record/i, label)
  }
})

test('validates the report bytes, handoff contract, digest, and ownership baseline', async () => {
  const invalidReport = await makeProofFixture()
  await writeFile(invalidReport.reportPath, 'not a five-field report\n')
  assert.match((await validate(invalidReport)).reason, /report contract or digest/i)

  const wrongSize = await makeProofFixture()
  const sizeProof = clone(wrongSize.proof)
  sizeProof.reportContract.size += 1
  await wrongSize.writeProof(sizeProof)
  assert.match((await validate(wrongSize)).reason, /report contract or digest/i)

  const wrongDigest = await makeProofFixture()
  const digestProof = clone(wrongDigest.proof)
  digestProof.reportContract.sha256 = '0'.repeat(64)
  await wrongDigest.writeProof(digestProof)
  assert.match((await validate(wrongDigest)).reason, /report contract or digest/i)

  const emptyReport = await makeProofFixture()
  await writeFile(emptyReport.reportPath, '')
  assert.match((await validate(emptyReport)).reason, /bounded regular file/i)

  const largeReport = await makeProofFixture()
  await writeFile(largeReport.reportPath, 'x'.repeat(1024 * 1024 + 1))
  assert.match((await validate(largeReport)).reason, /bounded regular file/i)

  const baseline = await makeProofFixture()
  const baselineProof = clone(baseline.proof)
  baselineProof.baselinePath = path.join(baseline.workerRoot, 'workspace-baseline.json')
  await baseline.writeProof(baselineProof)
  assert.match((await validate(baseline)).reason, /baseline path/i)
})

test('binds proof to the declared Sol-Max controller and workspace', async () => {
  const cases = [
    ['run', (run) => { run.runId = 'other-run' }],
    ['cwd', (run) => { run.cwd = path.join(path.dirname(run.cwd), 'other-repo') }],
    ['model', (run) => { run.controller.model = 'gpt-5.6-terra' }],
    ['effort', (run) => { run.controller.effort = 'high' }],
    ['authority', (run) => { run.controller.authority = 'worker' }],
    ['attestation', (run) => { run.controller.attestation = 'self-reported' }],
    ['backend', (run) => { run.workerBackend = 'native' }],
  ]
  for (const [label, mutate] of cases) {
    const fixture = await makeProofFixture()
    const run = clone(fixture.run)
    mutate(run)
    await fixture.writeRun(run)
    assert.match((await validate(fixture)).reason, /workspace or controller/i, label)
  }
})

test('contained JSON helpers reject traversal, symlinks, wrong types, size, and malformed data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-contained-'))
  const directory = path.join(root, 'directory')
  const file = path.join(root, 'value.json')
  await mkdir(directory)
  await writeFile(file, '{}')
  await assertContainedPath(root, root, { type: 'directory' })
  await assert.rejects(assertContainedPath(root, path.dirname(root)), /escapes its trusted root/i)
  await assert.rejects(assertContainedPath(file, file), /root is not a regular directory/i)
  await assert.rejects(assertContainedPath(root, file, { type: 'directory' }), /not a directory/i)
  await assert.rejects(assertContainedPath(root, directory, { type: 'file' }), /not a regular file/i)

  const link = path.join(root, 'link')
  await symlink(directory, link)
  await assert.rejects(assertContainedPath(root, link), /symlinked component/i)

  await writeFile(file, 'x'.repeat(1024 * 1024 + 1))
  await assert.rejects(readContainedBoundedJson(root, file), /bounded regular JSON/i)
  await writeFile(file, '{broken')
  await assert.rejects(readContainedBoundedJson(root, file), /JSON/)
})

test('validation catches missing and malformed proof artifacts without throwing', async () => {
  const fixture = await makeProofFixture()
  await writeFile(fixture.proofPath, '{broken')
  assert.match((await validate(fixture)).reason, /could not be validated/i)

  const missing = await makeProofFixture()
  assert.match((await validate(missing, {
    proofPath: path.join(missing.dataDir, 'runs', 'missing', 'workers', 'worker', 'proof.json'),
  })).reason, /could not be validated/i)
})

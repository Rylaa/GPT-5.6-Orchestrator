import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { resolveManagedAgentRole } from '../lib/routing.mjs'
import { validateClosure } from '../lib/qa.mjs'
import {
  buildCodexArguments,
  closeRun,
  createRun,
  defaultDataDir,
  getRunStatus,
  launchWorker,
  loadRun,
  materializeWorker,
  runReleaseEvidence,
  runTestEvidence,
  runWorker,
  stopWorkers,
  waitForWorkers,
} from '../scripts/orchestrator.mjs'

const execFileAsync = promisify(execFile)

async function makeWorkspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'g56o-workspace-'))
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'g56o-data-'))
  await mkdir(path.join(cwd, '.workflow', 'tasks'), { recursive: true })
  return { cwd, dataDir }
}

async function writeTask(cwd, name = 'task.md') {
  const taskPath = path.join(cwd, '.workflow', 'tasks', name)
  await writeFile(taskPath, 'Inspect package.json and return bounded evidence.\n')
  return taskPath
}

async function writeLedger(cwd, tier = 'Q1', status = 'x', profile = null) {
  const ledgerPath = path.join(cwd, '.workflow', 'LEDGER.md')
  const profileLine = profile ? `QA-Profile: ${profile}\n` : ''
  await writeFile(ledgerPath, `QA-Tier: ${tier}\n${profileLine}- [${status}] 1. Acceptance requirement\n`)
  return ledgerPath
}

async function makeReleaseWorkspace() {
  const fixture = await makeWorkspace()
  const remote = await mkdtemp(path.join(os.tmpdir(), 'g56o-remote-'))
  await writeFile(path.join(fixture.cwd, 'app.js'), 'export const ready = true\n')
  await writeLedger(fixture.cwd, 'Q1', 'x', 'deploy-fast')
  await execFileAsync('git', ['init', '-q', '-b', 'main', fixture.cwd])
  await execFileAsync('git', ['-C', fixture.cwd, 'config', 'user.email', 'release@example.invalid'])
  await execFileAsync('git', ['-C', fixture.cwd, 'config', 'user.name', 'Release Test'])
  await execFileAsync('git', ['-C', fixture.cwd, 'add', 'app.js'])
  await execFileAsync('git', ['-C', fixture.cwd, 'commit', '-qm', 'initial'])
  await execFileAsync('git', ['init', '--bare', '-q', remote])
  await execFileAsync('git', ['-C', fixture.cwd, 'remote', 'add', 'origin', remote])
  await execFileAsync('git', ['-C', fixture.cwd, 'push', '-qu', 'origin', 'main'])
  return { ...fixture, remote }
}

async function advanceRemote(remote) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'g56o-remote-writer-'))
  const clone = path.join(parent, 'clone')
  await execFileAsync('git', ['clone', '-q', '--branch', 'main', remote, clone])
  await execFileAsync('git', ['-C', clone, 'config', 'user.email', 'remote@example.invalid'])
  await execFileAsync('git', ['-C', clone, 'config', 'user.name', 'Remote Writer'])
  await writeFile(path.join(clone, 'remote-change.txt'), `${Date.now()}\n`)
  await execFileAsync('git', ['-C', clone, 'add', 'remote-change.txt'])
  await execFileAsync('git', ['-C', clone, 'commit', '-qm', 'advance remote'])
  await execFileAsync('git', ['-C', clone, 'push', '-q', 'origin', 'main'])
}

const passingCommand = () => [process.execPath, '-e', 'process.exit(0)']
const passingCiCommand = () => [...passingCommand(), '{sha}']

async function fakeCodex(root, { completed = true, exitCode = 0, delayMs = 0 } = {}) {
  const executable = path.join(root, `fake-codex-${completed}-${exitCode}-${delayMs}.mjs`)
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs'",
    'let prompt = ""',
    'for await (const chunk of process.stdin) prompt += chunk',
    'if (process.env.GPT56_ORCHESTRATOR_DISABLE !== "1") {',
    '  process.stderr.write("worker inherited automatic orchestrator hooks\\n")',
    '  process.exit(17)',
    '}',
    `await new Promise((resolve) => setTimeout(resolve, ${delayMs}))`,
    'const args = process.argv.slice(2)',
    'const outputIndex = args.indexOf("-o")',
    'writeFileSync(args[outputIndex + 1], "1. Ledger items addressed and scope: test\\n2. Evidence and files changed: none\\n3. Verification result: pass\\n4. Risks and unresolved issues: none\\n5. Confidence and out-of-scope findings: high\\n")',
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-test-123" }) + "\\n")',
    completed
      ? 'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 5 } }) + "\\n")'
      : 'process.stdout.write(JSON.stringify({ type: "item.completed" }) + "\\n")',
    `process.exitCode = ${exitCode}`,
    '',
  ].join('\n'))
  await chmod(executable, 0o700)
  return executable
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.resolve(import.meta.dirname, '..', 'scripts', 'orchestrator.mjs'),
      ...args,
    ], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('builds exact model, effort, fast-tier, sandbox, and no-descendant Codex args', () => {
  const role = resolveManagedAgentRole('orchestrator_sol_specialist')
  const args = buildCodexArguments({ role, cwd: '/tmp/project', outputPath: '/tmp/result.md' })
  assert.deepEqual(args.slice(0, 8), [
    'exec', '--ephemeral', '--ignore-user-config', '--disable', 'remote_plugin', '--json', '--color', 'never',
  ])
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.6-sol')
  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write')
  assert.ok(args.includes('model_reasoning_effort="max"'))
  assert.ok(args.includes('service_tier="fast"'))
  assert.ok(args.includes('features.multi_agent=false'))
  assert.equal(args.at(-1), '-')
})

test('creates a Sol-controlled run and materializes bounded workers safely', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  const run = await createRun({ cwd, objective: 'Review routing', runId: 'safe-run', dataDir })
  assert.deepEqual(run.controller, {
    model: 'gpt-5.6-sol', effort: 'max', authority: 'main-session',
  })
  assert.equal(run.workerBackend, 'codex-exec-background')

  const readWorker = await materializeWorker({
    runId: run.runId,
    workerId: 'scan',
    role: 'orchestrator_terra_explorer',
    taskFile,
    dataDir,
  })
  assert.equal(readWorker.status, 'queued')
  assert.equal(readWorker.model, 'gpt-5.6-terra')
  assert.equal(readWorker.effort, 'medium')

  await assert.rejects(() => materializeWorker({
    runId: run.runId,
    workerId: 'write',
    role: 'orchestrator_luna_worker',
    taskFile,
    dataDir,
  }), /requires explicit --allow-write/i)
  await assert.rejects(() => materializeWorker({
    runId: run.runId,
    workerId: 'unknown',
    role: 'worker',
    taskFile,
    dataDir,
  }), /unknown role/i)

  const outside = path.join(dataDir, 'outside.md')
  await writeFile(outside, 'outside\n')
  await assert.rejects(() => materializeWorker({
    runId: run.runId,
    workerId: 'outside',
    role: 'orchestrator_luna_gatherer',
    taskFile: outside,
    dataDir,
  }), /inside the run working directory/i)
  const symlinkPath = path.join(cwd, '.workflow', 'tasks', 'linked.md')
  await symlink(taskFile, symlinkPath)
  await assert.rejects(() => materializeWorker({
    runId: run.runId,
    workerId: 'linked',
    role: 'orchestrator_luna_gatherer',
    taskFile: symlinkPath,
    dataDir,
  }), /non-symlink/i)
})

test('rejects a symlinked run directory through both API and CLI access', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const runId = 'linked-run'
  const outsideRun = await mkdtemp(path.join(os.tmpdir(), 'g56o-outside-run-'))
  await mkdir(path.join(dataDir, 'runs'), { recursive: true })
  await writeFile(path.join(outsideRun, 'run.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    cwd,
    qaTier: 'q0',
    controller: { model: 'gpt-5.6-sol' },
  }))
  await symlink(outsideRun, path.join(dataDir, 'runs', runId))

  await assert.rejects(
    () => loadRun({ runId, dataDir }),
    /symlink|trusted root|outside/i,
  )
  const cli = await runCli(['status', '--run', runId, '--json'], {
    GPT56_ORCHESTRATOR_DATA_DIR: dataDir,
  })
  assert.equal(cli.code, 1)
  assert.match(cli.stderr, /symlink|trusted root|outside/i)
})

test('runs a pinned worker and records durable runtime proof', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  await createRun({ cwd, objective: 'Collect evidence', runId: 'proof-run', dataDir })
  await materializeWorker({
    runId: 'proof-run',
    workerId: 'gather',
    role: 'orchestrator_luna_gatherer',
    taskFile,
    dataDir,
  })
  const codexBin = await fakeCodex(dataDir)
  const proof = await runWorker({
    runId: 'proof-run',
    workerId: 'gather',
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: codexBin },
  })
  assert.equal(proof.status, 'completed')
  assert.equal(proof.role, 'orchestrator_luna_gatherer')
  assert.equal(proof.model, 'gpt-5.6-luna')
  assert.equal(proof.effort, 'low')
  assert.equal(proof.threadId, 'thread-test-123')
  assert.equal(proof.runtimeCompleted, true)
  assert.equal(proof.exitCode, 0)
  assert.match(await readFile(proof.resultPath, 'utf8'), /Verification result: pass/)

  const status = await getRunStatus({ runId: 'proof-run', dataDir })
  assert.equal(status.complete, true)
  assert.equal(status.successful, true)
  assert.deepEqual(status.counts, { completed: 1 })
  const waited = await waitForWorkers({
    runId: 'proof-run', workerId: 'gather', timeoutSeconds: 1, dataDir,
  })
  assert.equal(waited.selectedSuccessful, true)
})

test('records current tests, enforces tier review, closes QA, and detects staleness', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  await writeFile(path.join(cwd, 'app.js'), 'export const ready = true\n')
  await writeLedger(cwd, 'Q1')
  const taskFile = await writeTask(cwd, 'review.md')
  const run = await createRun({
    cwd,
    objective: 'Validate risk-based QA',
    runId: 'qa-run',
    qaTier: 'q1',
    dataDir,
  })
  assert.equal(run.qaTier, 'q1')
  const directTest = await runTestEvidence({
    runId: run.runId,
    testId: 'unit',
    command: [process.execPath, '-e', 'process.exit(0)'],
    dataDir,
  })
  assert.equal(directTest.status, 'passed')
  assert.match(directTest.proofPath, /tests\/unit\/proof\.json$/)

  await materializeWorker({
    runId: run.runId,
    workerId: 'review',
    role: 'orchestrator_luna_reviewer',
    taskFile,
    dataDir,
  })
  const reviewerProof = await runWorker({
    runId: run.runId,
    workerId: 'review',
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: await fakeCodex(dataDir) },
  })
  assert.equal(reviewerProof.workspaceStable, true)

  const reviewerPayload = JSON.parse(await readFile(reviewerProof.proofPath, 'utf8'))
  const actualReviewerStartedAt = reviewerPayload.startedAt
  reviewerPayload.startedAt = directTest.completedAt
  await writeFile(reviewerProof.proofPath, JSON.stringify(reviewerPayload))
  await assert.rejects(
    () => closeRun({ runId: run.runId, solVerdict: 'accepted', dataDir }),
    /strictly after direct tests/i,
  )
  reviewerPayload.startedAt = actualReviewerStartedAt
  await writeFile(reviewerProof.proofPath, JSON.stringify(reviewerPayload))

  const closure = await closeRun({
    runId: run.runId,
    solVerdict: 'accepted',
    dataDir,
  })
  assert.equal(closure.qaTier, 'q1')
  assert.deepEqual(closure.tests, [directTest.proofPath])
  assert.deepEqual(closure.reviews, [reviewerProof.proofPath])
  assert.equal((await validateClosure({ cwd, dataDir })).valid, true)

  reviewerPayload.startedAt = directTest.completedAt
  await writeFile(reviewerProof.proofPath, JSON.stringify(reviewerPayload))
  const overlappingReview = await validateClosure({ cwd, dataDir })
  assert.equal(overlappingReview.valid, false)
  assert.match(overlappingReview.reason, /strictly after direct tests/i)
  reviewerPayload.startedAt = actualReviewerStartedAt
  await writeFile(reviewerProof.proofPath, JSON.stringify(reviewerPayload))

  await writeFile(path.join(cwd, 'app.js'), 'export const ready = false\n')
  const stale = await validateClosure({ cwd, dataDir })
  assert.equal(stale.valid, false)
  assert.match(stale.reason, /workspace changed|stale/i)
})

test('failed or stale tests cannot satisfy QA closure', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  await writeFile(path.join(cwd, 'app.js'), 'export const ready = true\n')
  await writeLedger(cwd, 'Q1')
  await createRun({ cwd, objective: 'Reject failed QA', runId: 'qa-fail', qaTier: 'q1', dataDir })
  const failed = await runTestEvidence({
    runId: 'qa-fail',
    testId: 'failed',
    command: [process.execPath, '-e', 'process.exit(3)'],
    dataDir,
  })
  assert.equal(failed.status, 'failed')
  await assert.rejects(
    () => closeRun({ runId: 'qa-fail', solVerdict: 'accepted', dataDir }),
    /requires passing tests/i,
  )
})

test('deploy-fast closes Q1 from exact remote SHA, deploy, and smoke evidence without duplicate QA', async () => {
  const { cwd, dataDir, remote } = await makeReleaseWorkspace()
  const taskFile = await writeTask(cwd, 'forbidden-review.md')
  const run = await createRun({
    cwd,
    objective: 'Deploy an already green SHA',
    runId: 'deploy-fast-run',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir,
  })
  assert.equal(run.qaProfile, 'deploy-fast')
  await assert.rejects(() => materializeWorker({
    runId: run.runId,
    workerId: 'review',
    role: 'orchestrator_luna_reviewer',
    taskFile,
    dataDir,
  }), /does not allow a QA reviewer/i)
  await assert.rejects(
    () => closeRun({ runId: run.runId, solVerdict: 'accepted', dataDir }),
    /release|deploy|ENOENT/i,
  )

  const predeploy = await runReleaseEvidence({
    runId: run.runId,
    phase: 'predeploy',
    remote: 'origin',
    branch: 'main',
    command: passingCiCommand(),
    dataDir,
  })
  assert.equal(predeploy.status, 'passed')
  assert.equal(predeploy.localSha, predeploy.remoteSha)
  assert.equal(predeploy.shaBound, true)
  assert.ok(predeploy.command.includes(predeploy.gitSha))
  const deployed = await runReleaseEvidence({
    runId: run.runId,
    phase: 'deploy',
    target: 'preview.example.invalid',
    command: passingCommand(),
    dataDir,
  })
  assert.equal(deployed.status, 'passed')
  const smoke = await runReleaseEvidence({
    runId: run.runId,
    phase: 'smoke',
    target: 'preview.example.invalid',
    command: passingCommand(),
    dataDir,
  })
  assert.equal(smoke.status, 'passed')

  const closure = await closeRun({ runId: run.runId, solVerdict: 'accepted', dataDir })
  assert.equal(closure.qaTier, 'q1')
  assert.equal(closure.qaProfile, 'deploy-fast')
  assert.deepEqual(closure.tests, [])
  assert.deepEqual(closure.reviews, [])
  assert.equal(closure.release.target, 'preview.example.invalid')
  assert.equal((await validateClosure({ cwd, dataDir })).valid, true)

  const smokePayload = JSON.parse(await readFile(smoke.proofPath, 'utf8'))
  const actualSmokeStartedAt = smokePayload.startedAt
  smokePayload.startedAt = deployed.completedAt
  await writeFile(smoke.proofPath, JSON.stringify(smokePayload))
  const reordered = await validateClosure({ cwd, dataDir })
  assert.equal(reordered.valid, false)
  assert.match(reordered.reason, /smoke.*strictly after deploy/i)
  smokePayload.startedAt = actualSmokeStartedAt
  await writeFile(smoke.proofPath, JSON.stringify(smokePayload))

  await advanceRemote(remote)
  const remoteStale = await validateClosure({ cwd, dataDir })
  assert.equal(remoteStale.valid, false)
  assert.match(remoteStale.reason, /remote branch no longer matches/i)
  await execFileAsync('git', ['-C', cwd, 'push', '-q', '--force', 'origin', 'HEAD:main'])
  assert.equal((await validateClosure({ cwd, dataDir })).valid, true)

  await writeFile(path.join(cwd, 'app.js'), 'export const ready = false\n')
  const stale = await validateClosure({ cwd, dataDir })
  assert.equal(stale.valid, false)
  assert.match(stale.reason, /workspace changed|stale/i)
})

test('deploy-fast rejects dirty source, unpushed SHA, failed CI evidence, and target drift', async () => {
  const dirty = await makeReleaseWorkspace()
  await createRun({
    cwd: dirty.cwd,
    objective: 'Reject dirty release',
    runId: 'dirty-release',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: dirty.dataDir,
  })
  await writeFile(path.join(dirty.cwd, 'app.js'), 'export const ready = false\n')
  await assert.rejects(() => runReleaseEvidence({
    runId: 'dirty-release',
    phase: 'predeploy',
    remote: 'origin',
    branch: 'main',
    command: passingCommand(),
    dataDir: dirty.dataDir,
  }), /clean tracked source tree/i)

  const unpushed = await makeReleaseWorkspace()
  await writeFile(path.join(unpushed.cwd, 'app.js'), 'export const ready = false\n')
  await execFileAsync('git', ['-C', unpushed.cwd, 'add', 'app.js'])
  await execFileAsync('git', ['-C', unpushed.cwd, 'commit', '-qm', 'not pushed'])
  await createRun({
    cwd: unpushed.cwd,
    objective: 'Reject unpushed SHA',
    runId: 'unpushed-release',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: unpushed.dataDir,
  })
  await assert.rejects(() => runReleaseEvidence({
    runId: 'unpushed-release',
    phase: 'predeploy',
    remote: 'origin',
    branch: 'main',
    command: passingCommand(),
    dataDir: unpushed.dataDir,
  }), /does not match origin\/main/i)

  const failed = await makeReleaseWorkspace()
  await createRun({
    cwd: failed.cwd,
    objective: 'Record failed CI check',
    runId: 'failed-release',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: failed.dataDir,
  })
  const failedProof = await runReleaseEvidence({
    runId: 'failed-release',
    phase: 'predeploy',
    remote: 'origin',
    branch: 'main',
    command: [process.execPath, '-e', 'process.exit(7)', '{sha}'],
    dataDir: failed.dataDir,
  })
  assert.equal(failedProof.status, 'failed')
  await assert.rejects(() => runReleaseEvidence({
    runId: 'failed-release',
    phase: 'deploy',
    target: 'preview.example.invalid',
    command: passingCommand(),
    dataDir: failed.dataDir,
  }), /current predeploy evidence is required/i)

  const remoteDrift = await makeReleaseWorkspace()
  await createRun({
    cwd: remoteDrift.cwd,
    objective: 'Reject remote SHA drift',
    runId: 'remote-drift',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: remoteDrift.dataDir,
  })
  await runReleaseEvidence({
    runId: 'remote-drift', phase: 'predeploy', remote: 'origin', branch: 'main',
    command: passingCiCommand(), dataDir: remoteDrift.dataDir,
  })
  await advanceRemote(remoteDrift.remote)
  await assert.rejects(() => runReleaseEvidence({
    runId: 'remote-drift', phase: 'deploy', target: 'preview.example.invalid',
    command: passingCommand(), dataDir: remoteDrift.dataDir,
  }), /remote branch no longer matches/i)

  const drift = await makeReleaseWorkspace()
  await createRun({
    cwd: drift.cwd,
    objective: 'Reject release target drift',
    runId: 'target-drift',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: drift.dataDir,
  })
  await runReleaseEvidence({
    runId: 'target-drift', phase: 'predeploy', remote: 'origin', branch: 'main',
    command: passingCiCommand(), dataDir: drift.dataDir,
  })
  await runReleaseEvidence({
    runId: 'target-drift', phase: 'deploy', target: 'one.example.invalid',
    command: passingCommand(), dataDir: drift.dataDir,
  })
  await assert.rejects(() => runReleaseEvidence({
    runId: 'target-drift', phase: 'smoke', target: 'two.example.invalid',
    command: passingCommand(), dataDir: drift.dataDir,
  }), /target.*changed|target.*invalid/i)
  await assert.rejects(() => runReleaseEvidence({
    runId: 'target-drift', phase: 'predeploy', remote: '--upload-pack=bad', branch: 'main',
    command: passingCommand(), dataDir: drift.dataDir,
  }), /bounded named Git remote/i)
})

test('deploy-fast is Q1-only and must match the ledger profile', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  await assert.rejects(() => createRun({
    cwd,
    objective: 'Invalid profile tier',
    runId: 'invalid-profile-tier',
    qaTier: 'q2',
    qaProfile: 'deploy-fast',
    dataDir,
  }), /only valid with q1/i)

  await writeLedger(cwd, 'Q1')
  await assert.rejects(() => createRun({
    cwd,
    objective: 'Mismatched ledger profile',
    runId: 'profile-mismatch',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir,
  }), /does not match ledger profile standard/i)
})

test('release CLI contract rejects malformed input, duplicate phases, and active workers', async () => {
  const standard = await makeWorkspace()
  await writeLedger(standard.cwd, 'Q1')
  await createRun({
    cwd: standard.cwd,
    objective: 'Standard run cannot record release proof',
    runId: 'standard-release',
    qaTier: 'q1',
    dataDir: standard.dataDir,
  })
  await assert.rejects(() => runReleaseEvidence({
    runId: 'standard-release', phase: 'predeploy', branch: 'main',
    command: passingCommand(), dataDir: standard.dataDir,
  }), /only valid for q1 deploy-fast/i)

  const fixture = await makeReleaseWorkspace()
  await createRun({
    cwd: fixture.cwd,
    objective: 'Validate release inputs',
    runId: 'release-inputs',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: fixture.dataDir,
  })
  const base = { runId: 'release-inputs', dataDir: fixture.dataDir }
  await assert.rejects(
    () => runReleaseEvidence({ ...base, phase: 'publish', command: passingCommand() }),
    /phase must be one of/i,
  )
  await assert.rejects(
    () => runReleaseEvidence({ ...base, phase: 'predeploy', branch: 'main', command: [] }),
    /between 1 and 128 parts/i,
  )
  await assert.rejects(
    () => runReleaseEvidence({ ...base, phase: 'predeploy', branch: 'main', command: [''] }),
    /invalid part/i,
  )
  await assert.rejects(
    () => runReleaseEvidence({
      ...base, phase: 'predeploy', branch: 'main', command: passingCommand(), timeoutSeconds: 0,
    }),
    /timeout must be between/i,
  )
  await assert.rejects(
    () => runReleaseEvidence({
      ...base, phase: 'predeploy', branch: '--bad', command: passingCommand(),
    }),
    /bounded Git branch name/i,
  )
  await assert.rejects(
    () => runReleaseEvidence({
      ...base, phase: 'predeploy', remote: 'origin', branch: 'main', command: passingCommand(),
    }),
    /must include \{sha\}/i,
  )
  const literalSha = (await execFileAsync(
    'git', ['-C', fixture.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  )).stdout.trim()
  await assert.rejects(
    () => runReleaseEvidence({
      ...base,
      phase: 'predeploy',
      remote: 'origin',
      branch: 'main',
      command: [...passingCommand(), literalSha],
    }),
    /must include \{sha\}/i,
  )

  await runReleaseEvidence({
    ...base, phase: 'predeploy', remote: 'origin', branch: 'main', command: passingCiCommand(),
  })
  await assert.rejects(
    () => runReleaseEvidence({
      ...base, phase: 'predeploy', remote: 'origin', branch: 'main', command: passingCiCommand(),
    }),
    /already exists for phase predeploy/i,
  )
  await assert.rejects(
    () => runReleaseEvidence({ ...base, phase: 'deploy', command: passingCommand() }),
    /release target must contain/i,
  )

  const taskFile = await writeTask(fixture.cwd, 'active.md')
  await materializeWorker({
    runId: 'release-inputs',
    workerId: 'active',
    role: 'orchestrator_luna_gatherer',
    taskFile,
    dataDir: fixture.dataDir,
  })
  await assert.rejects(
    () => runReleaseEvidence({
      ...base, phase: 'deploy', target: 'preview', command: passingCommand(),
    }),
    /all workers must reach a terminal state/i,
  )
})

test('release logs are bounded and a missing executable records failed proof', async () => {
  const fixture = await makeReleaseWorkspace()
  await createRun({
    cwd: fixture.cwd,
    objective: 'Bound release logs',
    runId: 'release-log-limit',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: fixture.dataDir,
  })
  const overflow = await runReleaseEvidence({
    runId: 'release-log-limit',
    phase: 'predeploy',
    remote: 'origin',
    branch: 'main',
    command: [process.execPath, '-e', 'process.stdout.write("x".repeat(5 * 1024 * 1024))', '{sha}'],
    dataDir: fixture.dataDir,
  })
  assert.equal(overflow.status, 'failed')
  assert.equal(overflow.outputLimitExceeded, true)
  assert.equal((await readFile(overflow.stdoutPath)).length, 4 * 1024 * 1024)

  await createRun({
    cwd: fixture.cwd,
    objective: 'Record missing release executable',
    runId: 'release-missing-command',
    qaTier: 'q1',
    qaProfile: 'deploy-fast',
    dataDir: fixture.dataDir,
  })
  const missing = await runReleaseEvidence({
    runId: 'release-missing-command',
    phase: 'predeploy',
    remote: 'origin',
    branch: 'main',
    command: ['/definitely/missing/g56o-release-command', '{sha}'],
    dataDir: fixture.dataDir,
  })
  assert.equal(missing.status, 'failed')
  assert.match(missing.error, /ENOENT/i)
})

test('requires tests to start strictly after write workers finish', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  await writeFile(path.join(cwd, 'app.js'), 'export const ready = true\n')
  await writeLedger(cwd, 'Q1')
  const taskFile = await writeTask(cwd, 'write.md')
  await createRun({ cwd, objective: 'Order writer and tests', runId: 'qa-writer-order', qaTier: 'q1', dataDir })
  await materializeWorker({
    runId: 'qa-writer-order',
    workerId: 'writer',
    role: 'orchestrator_luna_worker',
    taskFile,
    allowWrite: true,
    dataDir,
  })
  const writerProof = await runWorker({
    runId: 'qa-writer-order',
    workerId: 'writer',
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: await fakeCodex(dataDir) },
  })
  await new Promise((resolve) => setTimeout(resolve, 2))
  const directTest = await runTestEvidence({
    runId: 'qa-writer-order',
    testId: 'unit',
    command: [process.execPath, '-e', 'process.exit(0)'],
    dataDir,
  })
  const testPayload = JSON.parse(await readFile(directTest.proofPath, 'utf8'))
  const actualTestStartedAt = testPayload.startedAt
  testPayload.startedAt = writerProof.completedAt
  await writeFile(directTest.proofPath, JSON.stringify(testPayload))
  await assert.rejects(
    () => closeRun({ runId: 'qa-writer-order', solVerdict: 'accepted', dataDir }),
    /passing tests after write workers finish/i,
  )
  testPayload.startedAt = actualTestStartedAt
  await writeFile(directTest.proofPath, JSON.stringify(testPayload))

  await materializeWorker({
    runId: 'qa-writer-order',
    workerId: 'review',
    role: 'orchestrator_luna_reviewer',
    taskFile,
    dataDir,
  })
  await runWorker({
    runId: 'qa-writer-order',
    workerId: 'review',
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: await fakeCodex(dataDir) },
  })
  await closeRun({ runId: 'qa-writer-order', solVerdict: 'accepted', dataDir })
  assert.equal((await validateClosure({ cwd, dataDir })).valid, true)

  testPayload.startedAt = writerProof.completedAt
  await writeFile(directTest.proofPath, JSON.stringify(testPayload))
  const reordered = await validateClosure({ cwd, dataDir })
  assert.equal(reordered.valid, false)
  assert.match(reordered.reason, /strictly after write workers/i)
})

test('Q3 requires Terra review followed by a Sol verifier', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  await writeFile(path.join(cwd, 'critical.js'), 'export const guarded = true\n')
  await writeLedger(cwd, 'Q3')
  const taskFile = await writeTask(cwd, 'critical-review.md')
  await createRun({ cwd, objective: 'Critical QA', runId: 'qa-q3', qaTier: 'q3', dataDir })
  await runTestEvidence({
    runId: 'qa-q3',
    testId: 'critical',
    command: [process.execPath, '-e', 'process.exit(0)'],
    dataDir,
  })
  const codexBin = await fakeCodex(dataDir)
  await materializeWorker({
    runId: 'qa-q3',
    workerId: 'terra-review',
    role: 'orchestrator_terra_reviewer',
    taskFile,
    dataDir,
  })
  const terraProof = await runWorker({
    runId: 'qa-q3',
    workerId: 'terra-review',
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: codexBin },
  })
  await assert.rejects(
    () => closeRun({ runId: 'qa-q3', solVerdict: 'accepted', dataDir }),
    /requires orchestrator_sol_verifier/i,
  )
  await materializeWorker({
    runId: 'qa-q3',
    workerId: 'sol-verify',
    role: 'orchestrator_sol_verifier',
    taskFile,
    dataDir,
  })
  const solProof = await runWorker({
    runId: 'qa-q3',
    workerId: 'sol-verify',
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: codexBin },
  })
  const solPayload = JSON.parse(await readFile(solProof.proofPath, 'utf8'))
  const actualSolStartedAt = solPayload.startedAt
  solPayload.startedAt = terraProof.completedAt
  await writeFile(solProof.proofPath, JSON.stringify(solPayload))
  await assert.rejects(
    () => closeRun({ runId: 'qa-q3', solVerdict: 'accepted', dataDir }),
    /strictly after Terra review/i,
  )
  solPayload.startedAt = actualSolStartedAt
  await writeFile(solProof.proofPath, JSON.stringify(solPayload))
  const closure = await closeRun({ runId: 'qa-q3', solVerdict: 'accepted', dataDir })
  assert.equal(closure.qaTier, 'q3')
  assert.equal(closure.reviews.length, 2)
})

test('fails closed when Codex output lacks a completed runtime event', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  await createRun({ cwd, objective: 'Reject weak proof', runId: 'failed-proof', dataDir })
  await materializeWorker({
    runId: 'failed-proof',
    workerId: 'gather',
    role: 'orchestrator_luna_gatherer',
    taskFile,
    dataDir,
  })
  const codexBin = await fakeCodex(dataDir, { completed: false })
  await assert.rejects(() => runWorker({
    runId: 'failed-proof',
    workerId: 'gather',
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: codexBin },
  }), /runtime proof validation/i)
  const status = await getRunStatus({ runId: 'failed-proof', dataDir })
  assert.equal(status.successful, false)
  assert.equal(status.workers[0].status, 'failed')
  const proof = JSON.parse(await readFile(status.workers[0].proofPath, 'utf8'))
  assert.equal(proof.runtimeCompleted, false)
})

test('launches a model-pinned Codex subagent in the background and can stop it', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  await createRun({ cwd, objective: 'Dynamic Codex subagent', runId: 'background-run', dataDir })
  const codexBin = await fakeCodex(dataDir, { delayMs: 5_000 })
  const launched = await launchWorker({
    runId: 'background-run',
    workerId: 'explore',
    role: 'orchestrator_terra_explorer',
    taskFile,
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: codexBin },
  })
  assert.equal(launched.status, 'queued')
  assert.equal(launched.backend, 'codex-exec-background')
  assert.equal(Number.isInteger(launched.processId), true)
  assert.match(launched.proofRequired, /proof\.json$/)

  let running
  for (let attempt = 0; attempt < 50; attempt += 1) {
    running = await getRunStatus({ runId: 'background-run', dataDir })
    if (running.workers[0].status === 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(running.workers[0].status, 'running')
  const stopped = await stopWorkers({ runId: 'background-run', workerId: 'explore', dataDir })
  assert.deepEqual(stopped.stopped, ['explore'])
  const status = await getRunStatus({ runId: 'background-run', dataDir })
  assert.equal(status.workers[0].status, 'stopped')
})

test('CLI exposes roles and rejects malformed commands', async () => {
  const roles = await runCli(['roles'])
  assert.equal(roles.code, 0)
  assert.equal(JSON.parse(roles.stdout).orchestrator_sol_verifier.effort, 'max')

  const malformed = await runCli(['create', '--cwd'])
  assert.equal(malformed.code, 1)
  assert.match(malformed.stderr, /requires a value/i)

  const unknown = await runCli(['explode'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stdout, /GPT-5\.6 Orchestrator Codex worker controller/)
})

test('CLI runs test evidence and writes an accepted Q0 closure', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  await writeFile(path.join(cwd, 'app.js'), 'export const ready = true\n')
  await writeLedger(cwd, 'Q0')
  const env = { GPT56_ORCHESTRATOR_DATA_DIR: dataDir }
  const created = await runCli([
    'create', '--cwd', cwd, '--objective', 'CLI QA', '--qa-tier', 'q0', '--run-id', 'qa-cli',
  ], env)
  assert.equal(created.code, 0)
  assert.equal(JSON.parse(created.stdout).qaTier, 'q0')
  const tested = await runCli([
    'test', '--run', 'qa-cli', '--test-id', 'smoke', '--',
    process.execPath, '-e', 'process.exit(0)',
  ], env)
  assert.equal(tested.code, 0)
  assert.equal(JSON.parse(tested.stdout).status, 'passed')
  const closed = await runCli([
    'close', '--run', 'qa-cli', '--sol-verdict', 'accepted',
  ], env)
  assert.equal(closed.code, 0)
  assert.equal(JSON.parse(closed.stdout).status, 'accepted')
})

test('CLI completes a provider-neutral deploy-fast release sequence', async () => {
  const { cwd, dataDir } = await makeReleaseWorkspace()
  const env = { GPT56_ORCHESTRATOR_DATA_DIR: dataDir }
  const created = await runCli([
    'create', '--cwd', cwd, '--objective', 'CLI deploy fast', '--qa-tier', 'q1',
    '--qa-profile', 'deploy-fast', '--run-id', 'release-cli',
  ], env)
  assert.equal(created.code, 0, created.stderr)
  assert.equal(JSON.parse(created.stdout).qaProfile, 'deploy-fast')

  const predeploy = await runCli([
    'release', '--run', 'release-cli', '--phase', 'predeploy', '--remote', 'origin',
    '--branch', 'main', '--', ...passingCiCommand(),
  ], env)
  assert.equal(predeploy.code, 0, predeploy.stderr)
  const deployed = await runCli([
    'release', '--run', 'release-cli', '--phase', 'deploy', '--target', 'cli-preview',
    '--', ...passingCommand(),
  ], env)
  assert.equal(deployed.code, 0, deployed.stderr)
  const smoke = await runCli([
    'release', '--run', 'release-cli', '--phase', 'smoke', '--target', 'cli-preview',
    '--', ...passingCommand(),
  ], env)
  assert.equal(smoke.code, 0, smoke.stderr)
  const closed = await runCli([
    'close', '--run', 'release-cli', '--sol-verdict', 'accepted',
  ], env)
  assert.equal(closed.code, 0, closed.stderr)
  assert.equal(JSON.parse(closed.stdout).release.target, 'cli-preview')
})

test('run and worker validation covers automatic IDs, empty runs, duplicates, and write approval', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  assert.equal(defaultDataDir({ GPT56_ORCHESTRATOR_DATA_DIR: dataDir }), path.resolve(dataDir))
  assert.match(defaultDataDir({}), /gpt-5-6-orchestrator$/)
  await assert.rejects(
    () => createRun({ cwd, objective: '', runId: 'bad-objective', dataDir }),
    /objective must contain/i,
  )
  await assert.rejects(
    () => createRun({ cwd, objective: 'valid', runId: '../bad', dataDir }),
    /run id must match/i,
  )
  const automatic = await createRun({ cwd, objective: 'Automatic identifier', dataDir })
  assert.match(automatic.runId, /^\d{14}-[a-f0-9]{8}$/)
  const emptyStatus = await getRunStatus({ runId: automatic.runId, dataDir })
  assert.equal(emptyStatus.complete, false)
  assert.equal(emptyStatus.successful, false)
  await assert.rejects(
    () => waitForWorkers({ runId: automatic.runId, timeoutSeconds: 0, dataDir }),
    /no matching workers/i,
  )
  await assert.rejects(
    () => createRun({ cwd, objective: 'Duplicate', runId: automatic.runId, dataDir }),
    /run already exists/i,
  )

  const taskFile = await writeTask(cwd, 'write.md')
  const writer = await materializeWorker({
    runId: automatic.runId,
    workerId: 'writer',
    role: 'orchestrator_luna_worker',
    taskFile,
    allowWrite: true,
    dataDir,
  })
  assert.equal(writer.sandbox, 'workspace-write')
  await assert.rejects(() => materializeWorker({
    runId: automatic.runId,
    workerId: 'writer',
    role: 'orchestrator_luna_worker',
    taskFile,
    allowWrite: true,
    dataDir,
  }), /worker already exists/i)

  const emptyTask = path.join(cwd, '.workflow', 'tasks', 'empty.md')
  await writeFile(emptyTask, '')
  await assert.rejects(() => materializeWorker({
    runId: automatic.runId,
    workerId: 'empty',
    role: 'orchestrator_luna_gatherer',
    taskFile: emptyTask,
    dataDir,
  }), /between 1 and 131072 bytes/i)
})

test('runs independent background subagents concurrently and fails closed on launch errors', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  await createRun({ cwd, objective: 'Parallel subagents', runId: 'parallel-run', dataDir })
  const codexBin = await fakeCodex(dataDir, { delayMs: 100 })
  for (const workerId of ['first', 'second']) {
    await launchWorker({
      runId: 'parallel-run',
      workerId,
      role: 'orchestrator_luna_gatherer',
      taskFile,
      dataDir,
      env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: codexBin },
    })
  }
  const parallel = await waitForWorkers({ runId: 'parallel-run', timeoutSeconds: 5, dataDir })
  assert.equal(parallel.selectedSuccessful, true)
  assert.equal(parallel.counts.completed, 2)

  await createRun({ cwd, objective: 'Fail process launch', runId: 'process-fail', dataDir })
  await assert.rejects(() => launchWorker({
    runId: 'process-fail',
    workerId: 'failed-launch',
    role: 'orchestrator_luna_gatherer',
    taskFile,
    dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_NODE_BIN: '/no/such/g56o-node' },
  }), /failed to launch Codex worker.*ENOENT/i)
  const failed = await getRunStatus({ runId: 'process-fail', dataDir })
  assert.equal(failed.workers[0].status, 'failed')
})

test('stops a whole run and CLI help accepts boolean options', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  await createRun({ cwd, objective: 'Stop all workers', runId: 'stop-all', dataDir })
  for (const workerId of ['one', 'two']) {
    await materializeWorker({
      runId: 'stop-all',
      workerId,
      role: 'orchestrator_luna_gatherer',
      taskFile,
      dataDir,
    })
  }
  const stopped = await stopWorkers({
    runId: 'stop-all',
    dataDir,
  })
  assert.deepEqual(stopped.stopped, ['one', 'two'])
  await assert.rejects(
    () => stopWorkers({ runId: 'stop-all', workerId: 'missing', dataDir }),
    /unknown worker/i,
  )

  const help = await runCli(['help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Commands:/)
  const unexpected = await runCli(['roles', 'not-an-option'])
  assert.equal(unexpected.code, 1)
  assert.match(unexpected.stderr, /unexpected argument/i)
})

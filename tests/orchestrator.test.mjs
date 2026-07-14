import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

import { resolveManagedAgentRole } from '../lib/routing.mjs'
import {
  buildCodexArguments,
  createRun,
  defaultDataDir,
  getRunStatus,
  launchWorker,
  materializeWorker,
  runWorker,
  stopWorkers,
  waitForWorkers,
} from '../scripts/orchestrator.mjs'

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
  assert.deepEqual(args.slice(0, 6), [
    'exec', '--ephemeral', '--ignore-user-config', '--json', '--color', 'never',
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

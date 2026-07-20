import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { resolveManagedAgentRole } from '../lib/routing.mjs'
import {
  buildCodexArguments,
  buildPaneDashboardCommand,
  createRun,
  defaultDataDir,
  getRunStatus,
  launchWorker,
  loadRun,
  materializeWorker,
  openTmuxPane,
  pruneRuns,
  renderDashboard,
  runDashboard,
  runWorker,
  stopWorkers,
  validateTaskContract,
  waitForWorkers,
} from '../scripts/orchestrator.mjs'

const execFileAsync = promisify(execFile)

async function makeWorkspace() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'g56o-workspace-'))
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'g56o-data-'))
  await execFileAsync('git', ['init', '-q', cwd])
  await mkdir(path.join(cwd, '.workflow', 'tasks'), { recursive: true })
  return { cwd, dataDir }
}

async function writeTask(cwd, name = 'task.md') {
  const taskPath = path.join(cwd, '.workflow', 'tasks', name)
  await writeFile(taskPath, 'Inspect package.json and return bounded evidence.\n')
  return taskPath
}

async function fakeCodex(root, {
  completed = true,
  exitCode = 0,
  delayMs = 0,
  reportContent = '1. Ledger items addressed and scope: test\n2. Evidence and files changed: none\n3. Verification result: pass\n4. Risks and unresolved issues: none\n5. Confidence and out-of-scope findings: high\n',
  writeRelative = null,
} = {}) {
  const executable = path.join(root, 'fake-codex-' + randomUUID() + '.mjs')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    "import { dirname, resolve } from 'node:path'",
    'let prompt = ""',
    'for await (const chunk of process.stdin) prompt += chunk',
    'if (process.env.GPT56_ORCHESTRATOR_DISABLE !== "1") {',
    '  process.stderr.write("worker inherited automatic orchestrator hooks\\n")',
    '  process.exit(17)',
    '}',
    `await new Promise((resolve) => setTimeout(resolve, ${delayMs}))`,
    'const args = process.argv.slice(2)',
    'const outputIndex = args.indexOf("-o")',
    ...(writeRelative ? [
      'const writeTarget = resolve(process.cwd(), ' + JSON.stringify(writeRelative) + ')',
      'mkdirSync(dirname(writeTarget), { recursive: true })',
      'writeFileSync(writeTarget, "worker change\\n")',
    ] : []),
    ...(reportContent === null
      ? []
      : ['writeFileSync(args[outputIndex + 1], ' + JSON.stringify(reportContent) + ')']),
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
  const args = buildCodexArguments({
    role,
    cwd: '/tmp/project',
    outputPath: '/tmp/result.md',
    scratchPath: '/tmp/scratch',
  })
  assert.deepEqual(args.slice(0, 10), [
    'exec', '--ephemeral', '--ignore-user-config', '--disable', 'remote_plugin', '--disable', 'plugins', '--json', '--color', 'never',
  ])
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.6-sol')
  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write')
  assert.ok(args.includes('model_reasoning_effort="high"'))
  assert.ok(args.includes('service_tier="fast"'))
  assert.ok(args.includes('features.multi_agent=false'))
  assert.equal(args[args.indexOf('--add-dir') + 1], '/tmp/scratch')
  assert.equal(args.at(-1), '-')
})

test('keeps read-only workers read-only and relies on the captured report handoff', () => {
  const role = resolveManagedAgentRole('orchestrator_luna_gatherer')
  const args = buildCodexArguments({
    role,
    cwd: '/tmp/project',
    outputPath: '/tmp/report.md',
    scratchPath: '/tmp/scratch',
  })
  assert.equal(args[args.indexOf('-s') + 1], 'read-only')
  assert.equal(args.includes('--add-dir'), false)
  assert.equal(args[args.indexOf('-o') + 1], '/tmp/report.md')
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

test('creates a Sol-controlled run and materializes bounded workers safely', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  const run = await createRun({ cwd, objective: 'Review routing', runId: 'safe-run', dataDir })
  assert.deepEqual(run.controller, {
    model: 'gpt-5.6-sol', effort: 'high', effortSource: 'default', authority: 'main-session',
    attestation: 'declared-main-session-contract',
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
  assert.equal(readWorker.effort, 'max')

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

test('reclaims stale controller locks and serializes concurrent run creation', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const lockPath = path.join(dataDir, '.controller-lock')
  await mkdir(lockPath)
  const stale = new Date(Date.now() - 60_000)
  await utimes(lockPath, stale, stale)
  const [first, second] = await Promise.all([
    createRun({ cwd, objective: 'First concurrent run', runId: 'lock-run-one', dataDir }),
    createRun({ cwd, objective: 'Second concurrent run', runId: 'lock-run-two', dataDir }),
  ])
  assert.equal(first.runId, 'lock-run-one')
  assert.equal(second.runId, 'lock-run-two')
  await assert.rejects(readFile(path.join(lockPath, 'owner-token')), /ENOENT/)
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
  assert.equal(proof.effort, 'max')
  assert.equal(proof.threadId, 'thread-test-123')
  assert.equal(proof.runtimeCompleted, true)
  assert.equal(proof.schemaVersion, 3)
  assert.equal(proof.launchContract.source, 'controller-cli-request')
  assert.equal(proof.runtimeEvidence.lifecycleValid, true)
  assert.equal(proof.runtimeEvidence.modelObserved, false)
  assert.equal(proof.reportContract.valid, true)
  assert.equal(proof.ownership.valid, true)
  assert.deepEqual(proof.recursionGuard, {
    multiAgentDisabled: true,
    pluginsDisabled: true,
    orchestratorHooksDisabled: true,
  })
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
  }), /runtime, handoff, or ownership proof validation/i)
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
  assert.deepEqual(stopped.signaled, ['explore'])
  await new Promise((resolve) => setTimeout(resolve, 150))
  const status = await getRunStatus({ runId: 'background-run', dataDir })
  assert.equal(status.workers[0].status, 'stopped')
})

test('CLI configures Sol effort, exposes resolved roles, and rejects malformed commands', async () => {
  const { dataDir } = await makeWorkspace()
  const env = { GPT56_ORCHESTRATOR_DATA_DIR: dataDir }
  const configured = await runCli(['config', '--sol-effort', 'medium'], env)
  assert.equal(configured.code, 0)
  const parsedConfig = JSON.parse(configured.stdout)
  assert.equal(parsedConfig.solEffort, 'medium')
  assert.deepEqual(parsedConfig.allowedSolEfforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.match(parsedConfig.mainSession.currentChat, /reasoning/)

  const roles = await runCli(['roles'], env)
  assert.equal(roles.code, 0)
  const parsedRoles = JSON.parse(roles.stdout)
  assert.equal(parsedRoles.orchestrator_sol_specialist.effort, 'medium')
  assert.equal(parsedRoles.orchestrator_terra_worker.effort, 'max')
  assert.equal(parsedRoles.orchestrator_sol_verifier, undefined)
  assert.equal(parsedRoles.orchestrator_luna_reviewer, undefined)
  assert.equal(parsedRoles.orchestrator_terra_reviewer, undefined)

  const overrideRun = await runCli([
    'create', '--cwd', path.dirname(dataDir), '--objective', 'Override Sol effort',
    '--run-id', 'cli-effort-run', '--sol-effort', 'xhigh',
  ], env)
  assert.equal(overrideRun.code, 0)
  assert.equal(JSON.parse(overrideRun.stdout).controller.effort, 'xhigh')

  const unsupported = await runCli(['config', '--sol-effort', 'ultra'], env)
  assert.equal(unsupported.code, 1)
  assert.match(unsupported.stderr, /unsupported sol reasoning effort/i)

  const malformed = await runCli(['create', '--cwd'])
  assert.equal(malformed.code, 1)
  assert.match(malformed.stderr, /requires a value/i)

  const unknown = await runCli(['explode'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stdout, /GPT-5\.6 Orchestrator Codex worker controller/)
  assert.doesNotMatch(unknown.stdout, /qa-tier|deploy-fast|test --run|release --run|close --run/i)
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
    owns: 'src/write.js',
    dataDir,
  })
  assert.equal(writer.sandbox, 'workspace-write')
  await assert.rejects(() => materializeWorker({
    runId: automatic.runId,
    workerId: 'writer',
    role: 'orchestrator_luna_worker',
    taskFile,
    allowWrite: true,
    owns: 'src/write.js',
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

test('validates the complete controller contract and detailed task contracts', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const run = await createRun({ cwd, objective: 'Validate contracts', runId: 'contract-run', dataDir })
  const manifestPath = path.join(dataDir, 'runs', run.runId, 'run.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.controller.effort = 'ultra'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(() => loadRun({ runId: run.runId, dataDir }), /controller contract/i)

  const detailed = [
    'Ledger items: R2, C1',
    'Objective: Validate the bounded change.',
    'Inputs: Current implementation and task fixture.',
    'Allowed files: lib/example.mjs',
    'Acceptance checks: Add focused tests.',
    'Return exactly:',
    ...[
      '1. Ledger items addressed and scope',
      '2. Evidence and files changed',
      '3. Verification result',
      '4. Risks and unresolved issues',
      '5. Confidence and out-of-scope findings',
    ],
  ].join('\n')
  assert.deepEqual(validateTaskContract({
    task: detailed,
    ledger: { content: '- [ ] R2. runtime\n- [ ] C1. safety\n' },
  }).ledgerIds, ['R2', 'C1'])
  assert.deepEqual(validateTaskContract({
    task: detailed.replace('R2, C1', 'R2-R4, 1-2, V'),
    ledger: {
      content: '- [ ] R2. a\n- [ ] R3. b\n- [ ] R4. c\n- [ ] 1. d\n- [ ] 2. e\n- [ ] V. close\n',
    },
  }).ledgerIds, ['R2', 'R3', 'R4', '1', '2', 'V'])
  assert.throws(
    () => validateTaskContract({ task: detailed.replace('R2, C1', 'R8'), ledger: { content: '- [ ] R2. runtime\n' } }),
    /do not exist/i,
  )
  assert.throws(
    () => validateTaskContract({ task: `${detailed}\n${'x'.repeat(2_000)}` }),
    /require a ledger/i,
  )
  assert.throws(
    () => validateTaskContract({ task: detailed.replace('Inputs: Current implementation and task fixture.\n', '') }),
    /missing inputs/i,
  )
})

test('serializes writers per workspace while preserving read-only parallelism', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  await createRun({ cwd, objective: 'Ownership', runId: 'ownership-run', dataDir })
  await assert.rejects(() => materializeWorker({
    runId: 'ownership-run', workerId: 'missing-owns', role: 'orchestrator_luna_worker',
    taskFile, allowWrite: true, dataDir,
  }), /require a non-empty --owns/i)
  await assert.rejects(() => materializeWorker({
    runId: 'ownership-run', workerId: 'unsafe-owns', role: 'orchestrator_luna_worker',
    taskFile, allowWrite: true, owns: '../src', dataDir,
  }), /unsafe or ambiguous/i)
  await symlink(path.join(cwd, '.workflow'), path.join(cwd, 'linked-scope'))
  await assert.rejects(() => materializeWorker({
    runId: 'ownership-run', workerId: 'linked-owns', role: 'orchestrator_luna_worker',
    taskFile, allowWrite: true, owns: 'linked-scope/task.md', dataDir,
  }), /symlinked component/i)
  await materializeWorker({
    runId: 'ownership-run', workerId: 'writer-one', role: 'orchestrator_luna_worker',
    taskFile, allowWrite: true, owns: 'src/one.js', dataDir,
  })
  await assert.rejects(() => materializeWorker({
    runId: 'ownership-run', workerId: 'writer-overlap', role: 'orchestrator_terra_worker',
    taskFile, allowWrite: true, owns: 'src', dataDir,
  }), /overlaps active worker/i)
  await assert.rejects(() => materializeWorker({
    runId: 'ownership-run', workerId: 'writer-two', role: 'orchestrator_terra_worker',
    taskFile, allowWrite: true, owns: 'lib/two.js', dataDir,
  }), /workspace already has active write worker.*worktree/i)
  const reader = await materializeWorker({
    runId: 'ownership-run', workerId: 'reader', role: 'orchestrator_luna_gatherer', taskFile, dataDir,
  })
  assert.equal(reader.status, 'queued')
})

test('renders a pure dashboard and opens a right-side pane only from an attached tmux client', async () => {
  const rendered = renderDashboard({
    runId: 'dashboard-run', objective: 'Observe workers',
    controller: { model: 'gpt-5.6-sol', effort: 'max', authority: 'main-session' },
    workerBackend: 'codex-exec-background', complete: false, successful: false,
    counts: { running: 1 }, workers: [{
      workerId: 'worker', status: 'running', role: 'orchestrator_terra_worker',
      owns: ['lib/worker.mjs'], reportPath: '/private/report.md',
    }],
  })
  assert.match(rendered, /Controller: gpt-5\.6-sol max/)
  assert.match(rendered, /worker\trunning/)
  assert.match(buildPaneDashboardCommand({ runId: 'dashboard-run', intervalMs: 25 }), /'dashboard-run'/)
  await assert.rejects(() => openTmuxPane({ runId: 'dashboard-run', env: {} }), /existing tmux client/i)

  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-tmux-'))
  const tmux = path.join(root, 'fake-tmux.mjs')
  const tmuxLog = path.join(root, 'tmux.log')
  await writeFile(tmux, [
    '#!/usr/bin/env node',
    'const fs = await import("node:fs")',
    'fs.appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")',
    'if (process.argv[2] === "display-message") process.stdout.write("/dev/pts/1\\n")',
    'else if (process.argv[2] === "split-window") process.stdout.write("%42\\n")',
    'else if (process.argv[2] !== "select-pane") process.exitCode = 1',
  ].join('\n'))
  await chmod(tmux, 0o700)
  const pane = await openTmuxPane({
    runId: 'dashboard-run', width: 35, intervalMs: 25,
    env: {
      ...process.env,
      TMUX: 'test,1,0',
      GPT56_ORCHESTRATOR_TMUX_BIN: tmux,
      FAKE_TMUX_LOG: tmuxLog,
    },
  })
  assert.equal(pane.width, 35)
  assert.equal(pane.paneId, '%42')
  assert.match(pane.command, /'dashboard'/, 'dashboard command remains shell quoted')
  const tmuxCalls = (await readFile(tmuxLog, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(tmuxCalls[1].slice(0, 8), [
    'split-window', '-h', '-d', '-p', '35', '-P', '-F', '#{pane_id}',
  ])
  assert.deepEqual(tmuxCalls[2], ['select-pane', '-t', '%42', '-T', 'GPT-5.6 agents'])
})

test('enforces hard execution timeout and exact five-field reports', async () => {
  const timeoutFixture = await makeWorkspace()
  const timeoutTask = await writeTask(timeoutFixture.cwd)
  await createRun({
    cwd: timeoutFixture.cwd,
    objective: 'Bound runtime',
    runId: 'timeout-run',
    dataDir: timeoutFixture.dataDir,
  })
  await materializeWorker({
    runId: 'timeout-run',
    workerId: 'slow',
    role: 'orchestrator_luna_gatherer',
    taskFile: timeoutTask,
    executionTimeoutSeconds: 1,
    dataDir: timeoutFixture.dataDir,
  })
  const slowCodex = await fakeCodex(timeoutFixture.dataDir, { delayMs: 5_000 })
  await assert.rejects(() => runWorker({
    runId: 'timeout-run',
    workerId: 'slow',
    dataDir: timeoutFixture.dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: slowCodex },
  }), /exceeded 1 seconds/i)
  const timeoutStatus = await getRunStatus({ runId: 'timeout-run', dataDir: timeoutFixture.dataDir })
  const timeoutProof = JSON.parse(await readFile(timeoutStatus.workers[0].proofPath, 'utf8'))
  assert.equal(timeoutProof.terminationReason, 'execution-timeout')
  assert.equal(timeoutProof.status, 'failed')

  const reportFixture = await makeWorkspace()
  const reportTask = await writeTask(reportFixture.cwd)
  await createRun({
    cwd: reportFixture.cwd,
    objective: 'Validate report',
    runId: 'report-run',
    dataDir: reportFixture.dataDir,
  })
  await materializeWorker({
    runId: 'report-run', workerId: 'weak', role: 'orchestrator_luna_gatherer',
    taskFile: reportTask, dataDir: reportFixture.dataDir,
  })
  const weakCodex = await fakeCodex(reportFixture.dataDir, {
    reportContent: 'Verification result: pass\n',
  })
  await assert.rejects(() => runWorker({
    runId: 'report-run', workerId: 'weak', dataDir: reportFixture.dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: weakCodex },
  }), /handoff/i)
  const reportStatus = await getRunStatus({ runId: 'report-run', dataDir: reportFixture.dataDir })
  const reportProof = JSON.parse(await readFile(reportStatus.workers[0].proofPath, 'utf8'))
  assert.equal(reportProof.reportContract.valid, false)
})

test('accepts owned Git-visible writes and rejects ownership escape', async () => {
  const allowed = await makeWorkspace()
  const allowedTask = await writeTask(allowed.cwd)
  await createRun({ cwd: allowed.cwd, objective: 'Owned write', runId: 'owned-run', dataDir: allowed.dataDir })
  await materializeWorker({
    runId: 'owned-run', workerId: 'writer', role: 'orchestrator_luna_worker',
    taskFile: allowedTask, allowWrite: true, owns: 'src/owned.js', dataDir: allowed.dataDir,
  })
  const allowedCodex = await fakeCodex(allowed.dataDir, { writeRelative: 'src/owned.js' })
  const allowedProof = await runWorker({
    runId: 'owned-run', workerId: 'writer', dataDir: allowed.dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: allowedCodex },
  })
  assert.equal(allowedProof.ownership.valid, true)
  assert.deepEqual(allowedProof.ownership.changedPaths, ['src/owned.js'])

  const escaped = await makeWorkspace()
  const escapedTask = await writeTask(escaped.cwd)
  await createRun({ cwd: escaped.cwd, objective: 'Escape write', runId: 'escape-run', dataDir: escaped.dataDir })
  await materializeWorker({
    runId: 'escape-run', workerId: 'writer', role: 'orchestrator_luna_worker',
    taskFile: escapedTask, allowWrite: true, owns: 'src/owned.js', dataDir: escaped.dataDir,
  })
  const escapedCodex = await fakeCodex(escaped.dataDir, { writeRelative: 'outside.js' })
  await assert.rejects(() => runWorker({
    runId: 'escape-run', workerId: 'writer', dataDir: escaped.dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: escapedCodex },
  }), /ownership proof validation/i)
  const escapedStatus = await getRunStatus({ runId: 'escape-run', dataDir: escaped.dataDir })
  const escapedProof = JSON.parse(await readFile(escapedStatus.workers[0].proofPath, 'utf8'))
  assert.deepEqual(escapedProof.ownership.outsidePaths, ['outside.js'])
})

test('enforces writer serialization across runs sharing one workspace', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const taskFile = await writeTask(cwd)
  await createRun({ cwd, objective: 'First writer', runId: 'writer-run-one', dataDir })
  await createRun({ cwd, objective: 'Second writer', runId: 'writer-run-two', dataDir })
  await materializeWorker({
    runId: 'writer-run-one', workerId: 'first', role: 'orchestrator_luna_worker',
    taskFile, allowWrite: true, owns: 'src/one.js', dataDir,
  })
  await assert.rejects(() => materializeWorker({
    runId: 'writer-run-two', workerId: 'second', role: 'orchestrator_terra_worker',
    taskFile, allowWrite: true, owns: 'lib/two.js', dataDir,
  }), /workspace already has active write worker.*worktree/i)
})

test('serializes writers opened from different subdirectories of one Git worktree', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  const firstCwd = path.join(cwd, 'packages', 'one')
  const secondCwd = path.join(cwd, 'packages', 'two')
  await mkdir(path.join(firstCwd, '.workflow', 'tasks'), { recursive: true })
  await mkdir(path.join(secondCwd, '.workflow', 'tasks'), { recursive: true })
  const firstTask = await writeTask(firstCwd)
  const secondTask = await writeTask(secondCwd)
  await createRun({ cwd: firstCwd, objective: 'First nested writer', runId: 'nested-writer-one', dataDir })
  await createRun({ cwd: secondCwd, objective: 'Second nested writer', runId: 'nested-writer-two', dataDir })
  await materializeWorker({
    runId: 'nested-writer-one', workerId: 'first', role: 'orchestrator_luna_worker',
    taskFile: firstTask, allowWrite: true, owns: 'src/one.js', dataDir,
  })
  await assert.rejects(() => materializeWorker({
    runId: 'nested-writer-two', workerId: 'second', role: 'orchestrator_terra_worker',
    taskFile: secondTask, allowWrite: true, owns: 'lib/two.js', dataDir,
  }), /workspace already has active write worker.*worktree/i)
})

test('reconciles abandoned queued workers and auto-exits completed dashboards', async () => {
  const stale = await makeWorkspace()
  const staleTask = await writeTask(stale.cwd)
  await createRun({ cwd: stale.cwd, objective: 'Stale worker', runId: 'stale-run', dataDir: stale.dataDir })
  await materializeWorker({
    runId: 'stale-run', workerId: 'abandoned', role: 'orchestrator_luna_gatherer',
    taskFile: staleTask, dataDir: stale.dataDir,
  })
  const staleRecordPath = path.join(stale.dataDir, 'runs', 'stale-run', 'workers', 'abandoned', 'worker.json')
  const staleRecord = JSON.parse(await readFile(staleRecordPath, 'utf8'))
  staleRecord.updatedAt = '2020-01-01T00:00:00.000Z'
  await writeFile(staleRecordPath, JSON.stringify(staleRecord))
  const staleStatus = await getRunStatus({ runId: 'stale-run', dataDir: stale.dataDir })
  assert.equal(staleStatus.workers[0].status, 'failed')
  assert.match(staleStatus.workers[0].error, /launcher is no longer running/i)

  const complete = await makeWorkspace()
  const completeTask = await writeTask(complete.cwd)
  await createRun({ cwd: complete.cwd, objective: 'Dashboard complete', runId: 'dashboard-complete', dataDir: complete.dataDir })
  await materializeWorker({
    runId: 'dashboard-complete', workerId: 'done', role: 'orchestrator_luna_gatherer',
    taskFile: completeTask, dataDir: complete.dataDir,
  })
  const codexBin = await fakeCodex(complete.dataDir)
  await runWorker({
    runId: 'dashboard-complete', workerId: 'done', dataDir: complete.dataDir,
    env: { ...process.env, GPT56_ORCHESTRATOR_CODEX_BIN: codexBin },
  })
  const writes = []
  const dashboardStatus = await runDashboard({
    runId: 'dashboard-complete', watch: true, intervalMs: 10, dataDir: complete.dataDir,
    write: (value) => writes.push(value),
  })
  assert.equal(dashboardStatus.complete, true)
  assert.match(writes.join(''), /turn completed/i)
})

test('prune is dry-run first and moves only old terminal runs to recoverable trash', async () => {
  const { cwd, dataDir } = await makeWorkspace()
  await createRun({ cwd, objective: 'Old empty run', runId: 'old-run', dataDir })
  const oldManifestPath = path.join(dataDir, 'runs', 'old-run', 'run.json')
  const oldManifest = JSON.parse(await readFile(oldManifestPath, 'utf8'))
  oldManifest.createdAt = '2020-01-01T00:00:00.000Z'
  await writeFile(oldManifestPath, JSON.stringify(oldManifest))

  await createRun({ cwd, objective: 'Active run', runId: 'active-run', dataDir })
  const taskFile = await writeTask(cwd)
  await materializeWorker({
    runId: 'active-run', workerId: 'active', role: 'orchestrator_luna_gatherer',
    taskFile, dataDir,
  })
  const preview = await pruneRuns({ olderThanHours: 24, dataDir, now: Date.parse('2026-07-20T00:00:00Z') })
  assert.deepEqual(preview.candidates, ['old-run'])
  assert.deepEqual(preview.skippedActive, ['active-run'])
  assert.equal(preview.moved.length, 0)
  assert.ok(await readFile(oldManifestPath, 'utf8'))

  const applied = await pruneRuns({
    olderThanHours: 24, apply: true, dataDir, now: Date.parse('2026-07-20T00:00:00Z'),
  })
  assert.equal(applied.moved.length, 1)
  await assert.rejects(() => readFile(oldManifestPath, 'utf8'), /ENOENT/)
  assert.ok(await readFile(path.join(applied.moved[0].destination, 'run.json'), 'utf8'))
  assert.ok(await readFile(path.join(dataDir, 'runs', 'active-run', 'run.json'), 'utf8'))
})

test('CLI exposes the canonical data root and new lifecycle controls', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'g56o-cli-data-'))
  const result = await runCli(['data-dir'], { GPT56_ORCHESTRATOR_DATA_DIR: dataDir })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).dataDir, dataDir)
  const help = await runCli(['help'])
  assert.match(help.stdout, /execution-timeout-seconds/)
  assert.match(help.stdout, /prune --older-than-hours/)
  assert.match(help.stdout, /data-dir/)
})

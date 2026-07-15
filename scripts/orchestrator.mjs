#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  MANAGED_AGENT_TYPES,
  resolveManagedAgentRole,
} from '../lib/routing.mjs'
import {
  findLedger,
  parseLedger,
  readLedger,
} from '../lib/ledger.mjs'
import {
  assertContainedPath,
  gitHeadSha,
  gitRemoteBranchSha,
  isQaReviewRole,
  normalizeQaProfile,
  normalizeQaTier,
  qaPolicy,
  RELEASE_PHASES,
  readContainedBoundedJson,
  validateClosure,
  validateReleaseEvidence,
  validateReleaseProofPath,
  validateTestProofPath,
  validateWorkerProofPath,
  workspaceDigest,
} from '../lib/qa.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const execFileAsync = promisify(execFile)
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TERMINAL_STATES = new Set(['completed', 'failed', 'stopped'])
const MAX_TASK_BYTES = 128 * 1024
const MAX_CONCURRENCY = 8
const MAX_TEST_COMMAND_PARTS = 128
const MAX_TEST_TIMEOUT_SECONDS = 3600
const MAX_RELEASE_LOG_BYTES = 4 * 1024 * 1024
const MAX_GIT_BUFFER_BYTES = 8 * 1024 * 1024

export function defaultDataDir(env = process.env) {
  return path.resolve(
    env.GPT56_ORCHESTRATOR_DATA_DIR
      || path.join(os.homedir(), '.local', 'share', 'gpt-5-6-orchestrator'),
  )
}

function assertIdentifier(value, label) {
  if (!IDENTIFIER.test(String(value || ''))) {
    throw new Error(`${label} must match ${IDENTIFIER}`)
  }
  return String(value)
}

async function optionalStat(targetPath) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function ensurePrivateDirectory(targetPath) {
  const info = await optionalStat(targetPath)
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`Unsafe orchestration directory: ${targetPath}`)
  }
  if (!info) await mkdir(targetPath, { recursive: true, mode: 0o700 })
  await chmod(targetPath, 0o700)
}

async function writeJsonAtomic(targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await rename(temporaryPath, targetPath)
    await chmod(targetPath, 0o600)
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

function requiredTimestamp(value, label) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} has an invalid timestamp`)
  return parsed
}

function runsDir(dataDir) {
  return path.join(dataDir, 'runs')
}

function runDir(dataDir, runId) {
  return path.join(runsDir(dataDir), assertIdentifier(runId, 'run id'))
}

function workerDir(dataDir, runId, workerId) {
  return path.join(runDir(dataDir, runId), 'workers', assertIdentifier(workerId, 'worker id'))
}

function testsDir(dataDir, runId) {
  return path.join(runDir(dataDir, runId), 'tests')
}

function testDir(dataDir, runId, testId) {
  return path.join(testsDir(dataDir, runId), assertIdentifier(testId, 'test id'))
}

function releaseDir(dataDir, runId) {
  return path.join(runDir(dataDir, runId), 'release')
}

function releasePhaseDir(dataDir, runId, phase) {
  if (!RELEASE_PHASES.includes(String(phase || ''))) throw new Error('Invalid release phase')
  return path.join(releaseDir(dataDir, runId), phase)
}

export async function createRun({
  cwd,
  objective,
  runId,
  qaTier,
  qaProfile,
  dataDir = defaultDataDir(),
}) {
  const resolvedCwd = await realpath(path.resolve(cwd || process.cwd()))
  const cwdInfo = await lstat(resolvedCwd)
  if (!cwdInfo.isDirectory()) throw new Error(`Working directory is not a directory: ${resolvedCwd}`)
  const normalizedObjective = String(objective || '').trim()
  if (!normalizedObjective || normalizedObjective.length > 20_000) {
    throw new Error('objective must contain between 1 and 20000 characters')
  }
  const normalizedRunId = assertIdentifier(
    runId || `${timestampId()}-${randomUUID().slice(0, 8)}`,
    'run id',
  )
  const ledgerPath = await findLedger(resolvedCwd)
  const ledger = ledgerPath ? parseLedger(await readLedger(ledgerPath)) : null
  const normalizedQaTier = normalizeQaTier(qaTier || ledger?.qaTier || 'q1')
  if (ledger?.qaTier && normalizedQaTier !== ledger.qaTier) {
    throw new Error(`QA tier ${normalizedQaTier} does not match ledger tier ${ledger.qaTier}`)
  }
  const ledgerQaProfile = normalizeQaProfile(ledger?.qaProfile || 'standard', normalizedQaTier)
  const normalizedQaProfile = normalizeQaProfile(
    qaProfile || ledger?.qaProfile || 'standard',
    normalizedQaTier,
  )
  if (ledger && normalizedQaProfile !== ledgerQaProfile) {
    throw new Error(`QA profile ${normalizedQaProfile} does not match ledger profile ${ledgerQaProfile}`)
  }
  await ensurePrivateDirectory(dataDir)
  await ensurePrivateDirectory(runsDir(dataDir))
  const targetRunDir = runDir(dataDir, normalizedRunId)
  if (await optionalStat(targetRunDir)) throw new Error(`Run already exists: ${normalizedRunId}`)
  await mkdir(targetRunDir, { mode: 0o700 })
  await mkdir(path.join(targetRunDir, 'workers'), { mode: 0o700 })
  await mkdir(path.join(targetRunDir, 'tests'), { mode: 0o700 })
  await mkdir(path.join(targetRunDir, 'release'), { mode: 0o700 })
  const manifest = {
    schemaVersion: 1,
    runId: normalizedRunId,
    objective: normalizedObjective,
    cwd: resolvedCwd,
    qaTier: normalizedQaTier,
    qaProfile: normalizedQaProfile,
    controller: {
      model: 'gpt-5.6-sol',
      effort: 'max',
      authority: 'main-session',
    },
    workerBackend: 'codex-exec-background',
    createdAt: new Date().toISOString(),
  }
  await writeJsonAtomic(path.join(targetRunDir, 'run.json'), manifest)
  return { ...manifest, runDir: targetRunDir }
}

export async function loadRun({ runId, dataDir = defaultDataDir() }) {
  const targetRunDir = runDir(dataDir, runId)
  const manifest = await readContainedBoundedJson(
    runsDir(dataDir),
    path.join(targetRunDir, 'run.json'),
  )
  if (manifest.runId !== runId || manifest.controller?.model !== 'gpt-5.6-sol') {
    throw new Error(`Invalid Orchestrator run manifest: ${targetRunDir}`)
  }
  return {
    ...manifest,
    qaTier: normalizeQaTier(manifest.qaTier || 'q1'),
    qaProfile: normalizeQaProfile(
      manifest.qaProfile || 'standard',
      normalizeQaTier(manifest.qaTier || 'q1'),
    ),
    runDir: targetRunDir,
  }
}

function withinDirectory(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function copyTaskFile({ sourcePath, destinationPath, cwd }) {
  const sourceInfo = await lstat(sourcePath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Task file must be a regular non-symlink file: ${sourcePath}`)
  }
  if (sourceInfo.size === 0 || sourceInfo.size > MAX_TASK_BYTES) {
    throw new Error(`Task file must contain between 1 and ${MAX_TASK_BYTES} bytes`)
  }
  const resolvedSource = await realpath(sourcePath)
  if (!withinDirectory(cwd, resolvedSource)) {
    throw new Error('Task file must be inside the run working directory')
  }
  await copyFile(resolvedSource, destinationPath)
  await chmod(destinationPath, 0o600)
  return resolvedSource
}

async function listWorkerRecords({ runId, dataDir }) {
  const workersPath = path.join(runDir(dataDir, runId), 'workers')
  await assertContainedPath(runsDir(dataDir), workersPath, { type: 'directory' })
  const entries = await readdir(workersPath, { withFileTypes: true })
  const records = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Unsafe symlinked worker directory: ${entry.name}`)
    if (!entry.isDirectory() || !IDENTIFIER.test(entry.name)) continue
    const recordPath = path.join(workersPath, entry.name, 'worker.json')
    if (!await optionalStat(recordPath)) continue
    const record = await readContainedBoundedJson(runsDir(dataDir), recordPath)
    if (record.runId !== runId || record.workerId !== entry.name) {
      throw new Error(`Worker record identity mismatch: ${entry.name}`)
    }
    records.push(record)
  }
  return records.sort((left, right) => left.workerId.localeCompare(right.workerId))
}

async function writeWorkerRecord(dataDir, runId, workerId, record) {
  await writeJsonAtomic(path.join(workerDir(dataDir, runId, workerId), 'worker.json'), record)
}

export async function materializeWorker({
  runId,
  workerId,
  role: roleName,
  taskFile,
  allowWrite = false,
  dataDir = defaultDataDir(),
}) {
  const run = await loadRun({ runId, dataDir })
  const normalizedWorkerId = assertIdentifier(workerId, 'worker id')
  const role = resolveManagedAgentRole(roleName)
  if (!role) {
    throw new Error(`Unknown role ${roleName}. Choose one of: ${MANAGED_AGENT_TYPES.join(', ')}`)
  }
  if (run.qaProfile === 'deploy-fast' && isQaReviewRole(roleName)) {
    throw new Error('deploy-fast uses release evidence and does not allow a QA reviewer worker')
  }
  if (role.sandbox === 'workspace-write' && !allowWrite) {
    throw new Error(`${roleName} requires explicit --allow-write approval`)
  }
  const activeWorkers = (await listWorkerRecords({ runId, dataDir }))
    .filter((worker) => !TERMINAL_STATES.has(worker.status))
  if (activeWorkers.length >= MAX_CONCURRENCY) {
    throw new Error(`Run already has ${MAX_CONCURRENCY} active workers`)
  }
  const targetWorkerDir = workerDir(dataDir, runId, normalizedWorkerId)
  if (await optionalStat(targetWorkerDir)) {
    throw new Error(`Worker already exists: ${normalizedWorkerId}`)
  }
  await mkdir(targetWorkerDir, { mode: 0o700 })
  const copiedTaskPath = path.join(targetWorkerDir, 'task.md')
  try {
    const sourceTaskPath = await copyTaskFile({
      sourcePath: path.resolve(taskFile),
      destinationPath: copiedTaskPath,
      cwd: run.cwd,
    })
    const now = new Date().toISOString()
    const record = {
      schemaVersion: 1,
      runId,
      workerId: normalizedWorkerId,
      role: roleName,
      model: role.model,
      effort: role.effort,
      serviceTier: 'fast',
      sandbox: role.sandbox,
      lane: role.lane,
      status: 'queued',
      sourceTaskPath,
      taskPath: copiedTaskPath,
      createdAt: now,
      updatedAt: now,
    }
    await writeWorkerRecord(dataDir, runId, normalizedWorkerId, record)
    return record
  } catch (error) {
    await rm(targetWorkerDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export function buildCodexArguments({ role, cwd, outputPath }) {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--disable',
    'remote_plugin',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '-C',
    cwd,
    '-s',
    role.sandbox,
    '-m',
    role.model,
    '-c',
    `model_reasoning_effort="${role.effort}"`,
    '-c',
    'service_tier="fast"',
    '-c',
    'features.multi_agent=false',
    '-o',
    outputPath,
    '-',
  ]
}

function workerPrompt({ run, record, role, task }) {
  return [
    'You are a bounded worker controlled by a GPT-5.6 Sol Max main orchestration session.',
    'The Sol main session owns planning, task assignment, every consequential decision, and final acceptance.',
    `Run objective: ${run.objective}`,
    `Worker role: ${record.role}`,
    `Pinned runtime: ${role.model}, reasoning effort ${role.effort}, service tier fast, sandbox ${role.sandbox}.`,
    `Role contract: ${role.instructions}`,
    '',
    'Bounded task:',
    task,
  ].join('\n')
}

function parseRuntimeProof(events) {
  let threadId = null
  let completed = false
  let usage = null
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        threadId = event.thread_id
      }
      if (event.type === 'turn.completed') {
        completed = true
        usage = event.usage ?? usage
      }
    } catch {
      // Codex JSONL may contain a malformed diagnostic line; retain the raw log.
    }
  }
  return { threadId, completed, usage }
}

export async function runWorker({ runId, workerId, dataDir = defaultDataDir(), env = process.env }) {
  const run = await loadRun({ runId, dataDir })
  const targetWorkerDir = workerDir(dataDir, runId, workerId)
  let record = await readContainedBoundedJson(
    runsDir(dataDir),
    path.join(targetWorkerDir, 'worker.json'),
  )
  if (record.status !== 'queued') throw new Error(`Worker is not queued: ${workerId}`)
  const role = resolveManagedAgentRole(record.role)
  if (!role || role.model !== record.model || role.effort !== record.effort) {
    throw new Error(`Worker role pin does not match its manifest: ${workerId}`)
  }
  const startedAt = new Date().toISOString()
  record = {
    ...record,
    status: 'running',
    backend: 'codex-exec-background',
    startedAt,
    updatedAt: startedAt,
    pid: process.pid,
  }
  await writeWorkerRecord(dataDir, runId, workerId, record)
  const eventsPath = path.join(targetWorkerDir, 'events.jsonl')
  const stderrPath = path.join(targetWorkerDir, 'stderr.log')
  const outputPath = path.join(targetWorkerDir, 'result.md')
  const task = await readFile(record.taskPath, 'utf8')
  const prompt = workerPrompt({ run, record, role, task })
  const args = buildCodexArguments({ role, cwd: run.cwd, outputPath })
  const codexBin = env.GPT56_ORCHESTRATOR_CODEX_BIN || 'codex'
  let eventsHandle
  let stderrHandle
  let workspaceDigestStarted
  const qaReview = isQaReviewRole(record.role)
  try {
    workspaceDigestStarted = qaReview ? await workspaceDigest(run.cwd) : null
    eventsHandle = await open(eventsPath, 'w', 0o600)
    stderrHandle = await open(stderrPath, 'w', 0o600)
    const workerEnv = {
      ...env,
      GPT56_ORCHESTRATOR_DISABLE: '1',
    }
    const child = spawn(codexBin, args, {
      cwd: run.cwd,
      env: workerEnv,
      stdio: ['pipe', eventsHandle.fd, stderrHandle.fd],
    })
    const outcome = await new Promise((resolve, reject) => {
      let settled = false
      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        resolve({ code, signal })
      })
      child.stdin.once('error', () => {
        // Process-level error/close determines the worker outcome.
      })
      child.stdin.end(prompt)
    })
    await eventsHandle.close()
    await stderrHandle.close()
    eventsHandle = null
    stderrHandle = null
    const events = await readFile(eventsPath, 'utf8')
    const runtime = parseRuntimeProof(events)
    const resultInfo = await optionalStat(outputPath)
    const completedWorkspaceDigest = qaReview ? await workspaceDigest(run.cwd) : null
    const stableQaWorkspace = !qaReview || workspaceDigestStarted === completedWorkspaceDigest
    const success = outcome.code === 0
      && outcome.signal === null
      && runtime.threadId
      && runtime.completed
      && resultInfo?.isFile()
      && resultInfo.size > 0
      && (!isQaReviewRole(record.role) || stableQaWorkspace)
    const completedAt = new Date().toISOString()
    const proof = {
      schemaVersion: 1,
      status: success ? 'completed' : 'failed',
      runId,
      workerId,
      role: record.role,
      model: role.model,
      effort: role.effort,
      serviceTier: 'fast',
      sandbox: role.sandbox,
      threadId: runtime.threadId,
      runtimeCompleted: runtime.completed,
      exitCode: outcome.code,
      signal: outcome.signal,
      usage: runtime.usage,
      workspaceDigestStarted,
      workspaceDigest: completedWorkspaceDigest,
      workspaceStable: stableQaWorkspace,
      startedAt,
      completedAt,
      taskPath: record.taskPath,
      resultPath: outputPath,
      eventsPath,
      stderrPath,
    }
    const proofPath = path.join(targetWorkerDir, 'proof.json')
    await writeJsonAtomic(proofPath, proof)
    record = {
      ...record,
      status: proof.status,
      threadId: proof.threadId,
      completedAt,
      updatedAt: completedAt,
      proofPath,
      resultPath: outputPath,
      eventsPath,
      stderrPath,
    }
    await writeWorkerRecord(dataDir, runId, workerId, record)
    if (!success) throw new Error(`Worker ${workerId} failed runtime proof validation`)
    return { ...proof, proofPath }
  } catch (error) {
    await eventsHandle?.close().catch(() => {})
    await stderrHandle?.close().catch(() => {})
    const failedAt = new Date().toISOString()
    const current = await readContainedBoundedJson(
      runsDir(dataDir),
      path.join(targetWorkerDir, 'worker.json'),
    ).catch(() => record)
    if (!TERMINAL_STATES.has(current.status)) {
      await writeWorkerRecord(dataDir, runId, workerId, {
        ...current,
        status: 'failed',
        error: error.message,
        completedAt: failedAt,
        updatedAt: failedAt,
      })
    }
    throw error
  }
}

export async function launchWorker({
  runId,
  workerId,
  role,
  taskFile,
  allowWrite = false,
  dataDir = defaultDataDir(),
  env = process.env,
}) {
  const run = await loadRun({ runId, dataDir })
  const record = await materializeWorker({
    runId,
    workerId,
    role,
    taskFile,
    allowWrite,
    dataDir,
  })
  const childEnv = {
    ...env,
    GPT56_ORCHESTRATOR_DATA_DIR: dataDir,
  }
  const nodeBin = env.GPT56_ORCHESTRATOR_NODE_BIN || process.execPath
  let child
  try {
    child = spawn(nodeBin, [
      SCRIPT_PATH,
      '_worker',
      '--run',
      runId,
      '--worker',
      workerId,
    ], {
      cwd: run.cwd,
      env: childEnv,
      detached: true,
      stdio: 'ignore',
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } catch (error) {
    const failedAt = new Date().toISOString()
    await writeWorkerRecord(dataDir, runId, workerId, {
      ...record,
      status: 'failed',
      error: error.message,
      completedAt: failedAt,
      updatedAt: failedAt,
    })
    throw new Error(`Failed to launch Codex worker ${workerId}: ${error.message}`)
  }
  return {
    ...record,
    backend: 'codex-exec-background',
    processId: child.pid,
    proofRequired: path.join(workerDir(dataDir, runId, workerId), 'proof.json'),
  }
}

export async function getRunStatus({ runId, dataDir = defaultDataDir() }) {
  const run = await loadRun({ runId, dataDir })
  const workers = await listWorkerRecords({ runId, dataDir })
  const counts = workers.reduce((result, worker) => {
    result[worker.status] = (result[worker.status] || 0) + 1
    return result
  }, {})
  return {
    runId,
    objective: run.objective,
    cwd: run.cwd,
    qaTier: run.qaTier,
    qaProfile: run.qaProfile,
    controller: run.controller,
    workerBackend: run.workerBackend,
    complete: workers.length > 0 && workers.every((worker) => TERMINAL_STATES.has(worker.status)),
    successful: workers.length > 0 && workers.every((worker) => worker.status === 'completed'),
    counts,
    workers,
  }
}

function normalizeEvidenceCommand(command, label) {
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_TEST_COMMAND_PARTS) {
    throw new Error(`${label} command must contain between 1 and ${MAX_TEST_COMMAND_PARTS} parts`)
  }
  return command.map((part) => {
    const value = String(part)
    if (!value || value.length > 4096 || value.includes('\0')) {
      throw new Error(`${label} command contains an invalid part`)
    }
    return value
  })
}

function normalizeTestCommand(command) {
  return normalizeEvidenceCommand(command, 'test')
}

function normalizeReleaseTarget(target) {
  const normalized = String(target || '').trim()
  if (!normalized || normalized.length > 2048 || normalized.includes('\0')) {
    throw new Error('release target must contain between 1 and 2048 safe characters')
  }
  return normalized
}

function bindPredeployCommand(command, gitSha) {
  const hasPlaceholder = command.includes('{sha}')
  if (!hasPlaceholder) {
    throw new Error('predeploy command must include {sha} as an exact argument')
  }
  return command.map((part) => part === '{sha}' ? gitSha : part)
}

function normalizeRemote(remote) {
  const normalized = String(remote || '')
  if (!SAFE_REMOTE.test(normalized)) {
    throw new Error('remote must be a bounded named Git remote')
  }
  return normalized
}

async function gitText(cwd, args) {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    env: {
      ...process.env,
      GIT_ALLOW_PROTOCOL: 'file:https:http:ssh:git',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_SSH_COMMAND: 'ssh',
    },
  })
  return result.stdout
}

async function normalizeBranch(cwd, branch) {
  const normalized = String(branch || '')
  if (
    !normalized
    || normalized.length > 1024
    || normalized.startsWith('-')
    || normalized.includes('\0')
  ) throw new Error('branch must be a bounded Git branch name')
  await gitText(cwd, ['check-ref-format', '--branch', normalized])
  return normalized
}

async function gitRepositorySnapshot(cwd) {
  const root = (await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const gitSha = await gitHeadSha(root)
  const status = await gitText(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude).workflow',
    ':(exclude).workflow/**',
  ])
  return {
    root,
    gitSha,
    dirtyEntryCount: status.split('\0').filter(Boolean).length,
  }
}

function requireCleanReleaseSnapshot(snapshot) {
  if (snapshot.dirtyEntryCount > 0) {
    throw new Error(
      `deploy-fast requires a clean tracked source tree outside .workflow (${snapshot.dirtyEntryCount} change(s))`,
    )
  }
}

async function strictlyLaterIso(previousTimestamp = 0) {
  const previous = Number(previousTimestamp) || 0
  if (previous > Date.now() + 1000) throw new Error('Prior release evidence has a future timestamp')
  if (Date.now() <= previous) await delay(previous - Date.now() + 1)
  return new Date().toISOString()
}

async function runBoundedCommand({ command, cwd, env, timeoutSeconds, stdoutPath, stderrPath }) {
  let stdoutBytes = 0
  let stderrBytes = 0
  let outputLimitExceeded = false
  const stdoutChunks = []
  const stderrChunks = []
  let child
  let killTimer = null
  let timeoutTimer = null
  let timedOut = false

  const append = (chunk, chunks, currentBytes) => {
    const buffer = Buffer.from(chunk)
    const remaining = Math.max(0, MAX_RELEASE_LOG_BYTES - currentBytes)
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining))
    if (buffer.length > remaining) outputLimitExceeded = true
    return currentBytes + Math.min(buffer.length, remaining)
  }
  const terminate = () => {
    if (!child || child.killed) return
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
  }

  const outcome = await new Promise((resolve) => {
    let settled = false
    child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      stdoutBytes = append(chunk, stdoutChunks, stdoutBytes)
      if (outputLimitExceeded) terminate()
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes = append(chunk, stderrChunks, stderrBytes)
      if (outputLimitExceeded) terminate()
    })
    timeoutTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutSeconds * 1000)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      resolve({ code: null, signal: null, error: error.message })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      resolve({
        code,
        signal,
        error: timedOut
          ? 'release command timed out'
          : outputLimitExceeded ? 'release command exceeded the log limit' : null,
      })
    })
  })
  await Promise.all([
    writeFile(stdoutPath, Buffer.concat(stdoutChunks), { mode: 0o600 }),
    writeFile(stderrPath, Buffer.concat(stderrChunks), { mode: 0o600 }),
  ])
  return { ...outcome, timedOut, outputLimitExceeded }
}

function latestWriterCompletion(workers) {
  return Math.max(0, ...workers
    .filter((worker) => worker.sandbox === 'workspace-write' && TERMINAL_STATES.has(worker.status))
    .map((worker) => requiredTimestamp(worker.completedAt, `worker ${worker.workerId}`)))
}

async function validateReleasePrefix({
  phase,
  run,
  dataDir,
  digest,
  gitSha,
  latestWriterAt,
  target,
}) {
  if (phase === 'predeploy') return { completedAt: latestWriterAt }
  const predeploy = await validateReleaseProofPath({
    proofPath: path.join(releasePhaseDir(dataDir, run.runId, 'predeploy'), 'proof.json'),
    phase: 'predeploy',
    cwd: run.cwd,
    dataDir,
    expectedDigest: digest,
    expectedGitSha: gitSha,
    expectedRunId: run.runId,
  })
  if (!predeploy.valid) throw new Error(`Current predeploy evidence is required: ${predeploy.reason}`)
  const currentRemoteSha = await gitRemoteBranchSha(
    run.cwd,
    predeploy.proof.remote,
    predeploy.proof.branch,
  )
  if (currentRemoteSha !== gitSha) {
    throw new Error('The named remote branch no longer matches the release Git SHA')
  }
  if (requiredTimestamp(predeploy.proof.startedAt, 'predeploy') <= latestWriterAt) {
    throw new Error('Predeploy must start strictly after write workers finish')
  }
  if (phase === 'deploy') {
    return {
      completedAt: requiredTimestamp(predeploy.proof.completedAt, 'predeploy'),
      remote: predeploy.proof.remote,
      branch: predeploy.proof.branch,
      remoteSha: currentRemoteSha,
    }
  }
  const deploy = await validateReleaseProofPath({
    proofPath: path.join(releasePhaseDir(dataDir, run.runId, 'deploy'), 'proof.json'),
    phase: 'deploy',
    cwd: run.cwd,
    dataDir,
    expectedDigest: digest,
    expectedGitSha: gitSha,
    expectedRunId: run.runId,
    expectedTarget: target,
  })
  if (!deploy.valid) throw new Error(`Current deploy evidence is required: ${deploy.reason}`)
  if (
    deploy.proof.remote !== predeploy.proof.remote
    || deploy.proof.branch !== predeploy.proof.branch
  ) throw new Error('Named remote or branch changed between release phases')
  if (
    requiredTimestamp(deploy.proof.startedAt, 'deploy')
    <= requiredTimestamp(predeploy.proof.completedAt, 'predeploy')
  ) throw new Error('Deploy must start strictly after predeploy finishes')
  return {
    completedAt: requiredTimestamp(deploy.proof.completedAt, 'deploy'),
    remote: predeploy.proof.remote,
    branch: predeploy.proof.branch,
    remoteSha: currentRemoteSha,
  }
}

export async function runReleaseEvidence({
  runId,
  phase,
  command,
  remote = 'origin',
  branch,
  target,
  timeoutSeconds = 900,
  dataDir = defaultDataDir(),
  env = process.env,
}) {
  const run = await loadRun({ runId, dataDir })
  if (run.qaTier !== 'q1' || run.qaProfile !== 'deploy-fast') {
    throw new Error('release evidence is only valid for q1 deploy-fast runs')
  }
  const normalizedPhase = String(phase || '').toLowerCase()
  if (!RELEASE_PHASES.includes(normalizedPhase)) {
    throw new Error(`release phase must be one of ${RELEASE_PHASES.join(', ')}`)
  }
  const normalizedCommand = normalizeEvidenceCommand(command, 'release')
  const normalizedTimeout = Number(timeoutSeconds)
  if (!Number.isInteger(normalizedTimeout) || normalizedTimeout < 1 || normalizedTimeout > MAX_TEST_TIMEOUT_SECONDS) {
    throw new Error(`release timeout must be between 1 and ${MAX_TEST_TIMEOUT_SECONDS} seconds`)
  }
  const workers = await listWorkerRecords({ runId, dataDir })
  if (workers.some((worker) => !TERMINAL_STATES.has(worker.status))) {
    throw new Error('All workers must reach a terminal state before release evidence')
  }
  const latestWriterAt = latestWriterCompletion(workers)
  const snapshot = await gitRepositorySnapshot(run.cwd)
  requireCleanReleaseSnapshot(snapshot)
  const digest = await workspaceDigest(run.cwd)
  const normalizedTarget = normalizedPhase === 'predeploy' ? null : normalizeReleaseTarget(target)
  const requestedRemote = normalizedPhase === 'predeploy' ? normalizeRemote(remote) : null
  const requestedBranch = normalizedPhase === 'predeploy'
    ? await normalizeBranch(snapshot.root, branch)
    : null
  const requestedRemoteSha = normalizedPhase === 'predeploy'
    ? await gitRemoteBranchSha(snapshot.root, requestedRemote, requestedBranch)
    : null
  if (requestedRemoteSha && requestedRemoteSha !== snapshot.gitSha) {
    throw new Error(`Local HEAD does not match ${requestedRemote}/${requestedBranch}`)
  }

  const prefix = await validateReleasePrefix({
    phase: normalizedPhase,
    run,
    dataDir,
    digest,
    gitSha: snapshot.gitSha,
    latestWriterAt,
    target: normalizedTarget,
  })
  const normalizedRemote = requestedRemote || prefix.remote
  const normalizedBranch = requestedBranch || prefix.branch
  const remoteShaBefore = requestedRemoteSha || prefix.remoteSha
  const boundCommand = normalizedPhase === 'predeploy'
    ? bindPredeployCommand(normalizedCommand, snapshot.gitSha)
    : normalizedCommand
  const targetPhaseDir = releasePhaseDir(dataDir, runId, normalizedPhase)
  if (await optionalStat(targetPhaseDir)) {
    throw new Error(`Release evidence already exists for phase ${normalizedPhase}`)
  }
  await mkdir(targetPhaseDir, { mode: 0o700 })
  const stdoutPath = path.join(targetPhaseDir, 'stdout.log')
  const stderrPath = path.join(targetPhaseDir, 'stderr.log')
  const proofPath = path.join(targetPhaseDir, 'proof.json')
  const startedAt = await strictlyLaterIso(prefix.completedAt)
  const outcome = await runBoundedCommand({
    command: boundCommand,
    cwd: run.cwd,
    env: {
      ...env,
      GPT56_RELEASE_PHASE: normalizedPhase,
      GPT56_RELEASE_GIT_SHA: snapshot.gitSha,
      GPT56_RELEASE_TARGET: normalizedTarget || '',
    },
    timeoutSeconds: normalizedTimeout,
    stdoutPath,
    stderrPath,
  })

  let finalSnapshot = null
  let completedDigest = null
  let remoteSha = null
  let postconditionError = null
  try {
    finalSnapshot = await gitRepositorySnapshot(run.cwd)
    completedDigest = await workspaceDigest(run.cwd)
    remoteSha = await gitRemoteBranchSha(
      finalSnapshot.root,
      normalizedRemote,
      normalizedBranch,
    )
  } catch (error) {
    postconditionError = error.message
  }
  const workspaceChanged = !finalSnapshot
    || !completedDigest
    || finalSnapshot.gitSha !== snapshot.gitSha
    || completedDigest !== digest
    || finalSnapshot.dirtyEntryCount > 0
  const passed = outcome.code === 0
    && outcome.signal === null
    && outcome.timedOut === false
    && outcome.outputLimitExceeded === false
    && !postconditionError
    && workspaceChanged === false
    && remoteShaBefore === snapshot.gitSha
    && remoteSha === snapshot.gitSha
  const completedAt = new Date().toISOString()
  const proof = {
    schemaVersion: 1,
    status: passed ? 'passed' : 'failed',
    runId,
    phase: normalizedPhase,
    qaProfile: 'deploy-fast',
    command: boundCommand,
    shaBound: normalizedPhase === 'predeploy' ? true : null,
    exitCode: outcome.code,
    signal: outcome.signal,
    error: [outcome.error, postconditionError].filter(Boolean).join('; ') || null,
    timedOut: outcome.timedOut,
    outputLimitExceeded: outcome.outputLimitExceeded,
    gitSha: snapshot.gitSha,
    localSha: snapshot.gitSha,
    remote: normalizedRemote,
    branch: normalizedBranch,
    remoteShaBefore,
    remoteSha,
    target: normalizedTarget,
    workspaceDigestStarted: digest,
    workspaceDigest: completedDigest,
    workspaceChanged,
    startedAt,
    completedAt,
    stdoutPath,
    stderrPath,
  }
  await writeJsonAtomic(proofPath, proof)
  return { ...proof, proofPath }
}

export async function runTestEvidence({
  runId,
  testId,
  command,
  timeoutSeconds = 900,
  dataDir = defaultDataDir(),
  env = process.env,
}) {
  const run = await loadRun({ runId, dataDir })
  const normalizedTestId = assertIdentifier(testId, 'test id')
  const normalizedCommand = normalizeTestCommand(command)
  const normalizedTimeout = Number(timeoutSeconds)
  if (!Number.isInteger(normalizedTimeout) || normalizedTimeout < 1 || normalizedTimeout > MAX_TEST_TIMEOUT_SECONDS) {
    throw new Error(`test timeout must be between 1 and ${MAX_TEST_TIMEOUT_SECONDS} seconds`)
  }
  await ensurePrivateDirectory(testsDir(dataDir, runId))
  const targetTestDir = testDir(dataDir, runId, normalizedTestId)
  if (await optionalStat(targetTestDir)) throw new Error(`Test evidence already exists: ${normalizedTestId}`)
  await mkdir(targetTestDir, { mode: 0o700 })
  const stdoutPath = path.join(targetTestDir, 'stdout.log')
  const stderrPath = path.join(targetTestDir, 'stderr.log')
  const proofPath = path.join(targetTestDir, 'proof.json')
  const startedAt = new Date().toISOString()
  const workspaceDigestStarted = await workspaceDigest(run.cwd)
  const stdoutHandle = await open(stdoutPath, 'w', 0o600)
  const stderrHandle = await open(stderrPath, 'w', 0o600)
  let outcome
  try {
    outcome = await new Promise((resolve) => {
      let settled = false
      let timedOut = false
      const child = spawn(normalizedCommand[0], normalizedCommand.slice(1), {
        cwd: run.cwd,
        env,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, normalizedTimeout * 1000)
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: null, signal: null, error: error.message, timedOut })
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, signal, error: timedOut ? 'test timed out' : null, timedOut })
      })
    })
  } finally {
    await stdoutHandle.close()
    await stderrHandle.close()
  }
  const completedAt = new Date().toISOString()
  const completedWorkspaceDigest = await workspaceDigest(run.cwd)
  const passed = outcome.code === 0 && outcome.signal === null && outcome.timedOut !== true
  const proof = {
    schemaVersion: 1,
    status: passed ? 'passed' : 'failed',
    runId,
    testId: normalizedTestId,
    command: normalizedCommand,
    exitCode: outcome.code,
    signal: outcome.signal,
    error: outcome.error,
    timedOut: outcome.timedOut,
    workspaceDigestStarted,
    workspaceDigest: completedWorkspaceDigest,
    workspaceChanged: workspaceDigestStarted !== completedWorkspaceDigest,
    startedAt,
    completedAt,
    stdoutPath,
    stderrPath,
  }
  await writeJsonAtomic(proofPath, proof)
  return { ...proof, proofPath }
}

async function listTestProofPaths({ runId, dataDir }) {
  const root = testsDir(dataDir, runId)
  const info = await optionalStat(root)
  if (!info) return []
  await assertContainedPath(runsDir(dataDir), root, { type: 'directory' })
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .map((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Unsafe symlinked test directory: ${entry.name}`)
      return entry
    })
    .filter((entry) => entry.isDirectory() && IDENTIFIER.test(entry.name))
    .map((entry) => path.join(root, entry.name, 'proof.json'))
}

export async function closeRun({
  runId,
  solVerdict,
  acceptWorkerFailures = false,
  dataDir = defaultDataDir(),
}) {
  const run = await loadRun({ runId, dataDir })
  if (solVerdict !== 'accepted') throw new Error('Sol must explicitly pass --sol-verdict accepted')
  const ledgerPath = await findLedger(run.cwd)
  if (!ledgerPath) throw new Error('Create and close .workflow/LEDGER.md before QA closure')
  const ledger = parseLedger(await readLedger(ledgerPath))
  if (ledger.qaTier !== run.qaTier) {
    throw new Error(`Run tier ${run.qaTier} does not match ledger tier ${ledger.qaTier || 'missing'}`)
  }
  const ledgerProfile = normalizeQaProfile(ledger.qaProfile || 'standard', run.qaTier)
  if (ledgerProfile !== run.qaProfile) {
    throw new Error(`Run profile ${run.qaProfile} does not match ledger profile ${ledgerProfile}`)
  }
  if (ledger.totalItems === 0 || ledger.openItems.length > 0) {
    throw new Error(`Ledger must have no open items (${ledger.openItems.length} open)`)
  }
  const workers = await listWorkerRecords({ runId, dataDir })
  const activeWorkers = workers.filter((worker) => !TERMINAL_STATES.has(worker.status))
  if (activeWorkers.length > 0) throw new Error('All workers must reach a terminal state before closure')
  const nonSuccessfulWorkers = workers.filter((worker) => worker.status !== 'completed')
  if (nonSuccessfulWorkers.length > 0 && !acceptWorkerFailures) {
    throw new Error('Stopped or failed workers require --accept-worker-failures')
  }

  const currentDigest = await workspaceDigest(run.cwd)
  const tierPolicy = qaPolicy({ tier: run.qaTier, profile: run.qaProfile })
  const latestWriterAt = latestWriterCompletion(workers)
  let eligibleTests = []
  const reviewByRole = new Map()
  let releaseClosure = null

  if (tierPolicy.releaseRequired) {
    const predeployPath = path.join(releasePhaseDir(dataDir, runId, 'predeploy'), 'proof.json')
    const deployPath = path.join(releasePhaseDir(dataDir, runId, 'deploy'), 'proof.json')
    const smokePath = path.join(releasePhaseDir(dataDir, runId, 'smoke'), 'proof.json')
    const deployProof = await readContainedBoundedJson(runsDir(dataDir), deployPath)
    releaseClosure = {
      predeploy: predeployPath,
      deploy: deployPath,
      smoke: smokePath,
      target: deployProof.target,
    }
    const releaseResult = await validateReleaseEvidence({
      release: releaseClosure,
      cwd: run.cwd,
      dataDir,
      expectedDigest: currentDigest,
      expectedRunId: runId,
      latestWriterAt,
    })
    if (!releaseResult.valid) throw new Error(`deploy-fast release evidence is invalid: ${releaseResult.reason}`)
  } else {
    const currentTests = []
    for (const proofPath of await listTestProofPaths({ runId, dataDir })) {
      const result = await validateTestProofPath({
        proofPath,
        cwd: run.cwd,
        dataDir,
        expectedDigest: currentDigest,
        expectedRunId: runId,
      })
      if (result.valid) currentTests.push({ ...result.proof, proofPath })
    }
    eligibleTests = currentTests.filter(
      (proof) => requiredTimestamp(proof.startedAt, `test ${proof.testId}`) > latestWriterAt,
    )
    if (tierPolicy.testsRequired && eligibleTests.length === 0) {
      throw new Error(`${run.qaTier.toUpperCase()} requires passing tests after write workers finish`)
    }

    const currentReviews = []
    for (const worker of workers) {
      if (!isQaReviewRole(worker.role) || !worker.proofPath) continue
      const result = await validateWorkerProofPath({
        proofPath: worker.proofPath,
        cwd: run.cwd,
        dataDir,
        expectedDigest: currentDigest,
        requireStable: true,
        expectedRunId: runId,
      })
      if (result.valid) currentReviews.push({ ...result.proof, proofPath: worker.proofPath })
    }
    for (const proof of currentReviews) {
      const prior = reviewByRole.get(proof.role)
      if (
        !prior
        || requiredTimestamp(proof.completedAt, `review ${proof.workerId}`)
          > requiredTimestamp(prior.completedAt, `review ${prior.workerId}`)
      ) reviewByRole.set(proof.role, proof)
    }
    for (const role of tierPolicy.reviewRoles) {
      if (!reviewByRole.has(role)) throw new Error(`${run.qaTier.toUpperCase()} requires ${role}`)
    }
    const latestTestAt = Math.max(0, ...eligibleTests.map(
      (proof) => requiredTimestamp(proof.completedAt, `test ${proof.testId}`),
    ))
    for (const role of tierPolicy.reviewRoles) {
      const proof = reviewByRole.get(role)
      if (requiredTimestamp(proof.startedAt, `review ${proof.workerId}`) <= latestTestAt) {
        throw new Error(`${role} must start strictly after direct tests finish`)
      }
    }
    if (run.qaTier === 'q3') {
      const terraCompletedAt = requiredTimestamp(
        reviewByRole.get('orchestrator_terra_reviewer').completedAt,
        'Terra review',
      )
      const solStartedAt = requiredTimestamp(
        reviewByRole.get('orchestrator_sol_verifier').startedAt,
        'Sol verification',
      )
      if (solStartedAt <= terraCompletedAt) {
        throw new Error('Q3 Sol verification must start strictly after Terra review finishes')
      }
    }
  }

  const closurePath = path.join(path.dirname(ledgerPath), 'closure.json')
  const existingClosure = await optionalStat(closurePath)
  if (existingClosure?.isSymbolicLink() || (existingClosure && !existingClosure.isFile())) {
    throw new Error('Unsafe .workflow/closure.json target')
  }
  const closure = {
    schemaVersion: 1,
    status: 'accepted',
    runId,
    qaTier: run.qaTier,
    qaProfile: run.qaProfile,
    workspaceDigest: currentDigest,
    ledger: {
      path: path.relative(run.cwd, ledgerPath),
      totalItems: ledger.totalItems,
      closedItems: ledger.closedItems,
    },
    tests: eligibleTests.map((proof) => proof.proofPath),
    reviews: tierPolicy.reviewRoles.map((role) => reviewByRole.get(role).proofPath),
    release: releaseClosure,
    nonSuccessfulWorkers: nonSuccessfulWorkers.map((worker) => worker.workerId),
    solVerdict: 'accepted',
    createdAt: new Date().toISOString(),
  }
  await writeJsonAtomic(path.join(run.runDir, 'closure-receipt.json'), closure)
  await writeJsonAtomic(closurePath, closure)
  const validation = await validateClosure({ cwd: run.cwd, dataDir })
  if (!validation.valid) throw new Error(`Generated closure failed validation: ${validation.reason}`)
  return { ...closure, closurePath }
}

export async function waitForWorkers({
  runId,
  workerId,
  timeoutSeconds = 900,
  dataDir = defaultDataDir(),
}) {
  const deadline = Date.now() + Number(timeoutSeconds) * 1000
  while (Date.now() <= deadline) {
    const status = await getRunStatus({ runId, dataDir })
    const selected = workerId
      ? status.workers.filter((worker) => worker.workerId === workerId)
      : status.workers
    if (selected.length === 0) throw new Error(`No matching workers in run ${runId}`)
    if (selected.every((worker) => TERMINAL_STATES.has(worker.status))) {
      return { ...status, selectedSuccessful: selected.every((worker) => worker.status === 'completed') }
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${workerId || 'run'} after ${timeoutSeconds} seconds`)
}

export async function stopWorkers({ runId, workerId, dataDir = defaultDataDir() }) {
  await loadRun({ runId, dataDir })
  const workers = await listWorkerRecords({ runId, dataDir })
  const selected = workerId ? workers.filter((worker) => worker.workerId === workerId) : workers
  if (workerId && selected.length === 0) throw new Error(`Unknown worker: ${workerId}`)
  const stoppedAt = new Date().toISOString()
  const stopped = []
  for (const worker of selected) {
    if (TERMINAL_STATES.has(worker.status)) continue
    const pid = Number(worker.pid)
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM')
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
    await writeWorkerRecord(dataDir, runId, worker.workerId, {
      ...worker,
      status: 'stopped',
      completedAt: stoppedAt,
      updatedAt: stoppedAt,
    })
    stopped.push(worker.workerId)
  }
  return { runId, stopped }
}

function parseArguments(argv) {
  const [command = 'help', ...rest] = argv
  const separatorIndex = rest.indexOf('--')
  const optionTokens = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex)
  const passthrough = separatorIndex === -1 ? [] : rest.slice(separatorIndex + 1)
  const options = {}
  for (let index = 0; index < optionTokens.length; index += 1) {
    const token = optionTokens[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    if (['allow-write', 'accept-worker-failures', 'json'].includes(key)) {
      options[key] = true
      continue
    }
    const value = optionTokens[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
    options[key] = value
    index += 1
  }
  return { command, options, passthrough }
}

function printHelp() {
  process.stdout.write([
    'GPT-5.6 Orchestrator Codex worker controller',
    '',
    'Commands:',
    '  create --cwd <dir> --objective <text> --qa-tier <q0|q1|q2|q3> [--qa-profile <standard|deploy-fast>] [--run-id <id>]',
    '  spawn --run <id> --worker <id> --role <role> --task-file <path> [--allow-write]',
    '  test --run <id> --test-id <id> [--timeout-seconds <n>] -- <command> [args...]',
    '  release --run <id> --phase <predeploy|deploy|smoke> [--remote <name> --branch <name>] [--target <label>] [--timeout-seconds <n>] -- <command> [args...]',
    '    predeploy commands must contain {sha} as a standalone argument',
    '  close --run <id> --sol-verdict accepted [--accept-worker-failures]',
    '  status --run <id> [--json]',
    '  wait --run <id> [--worker <id>] [--timeout-seconds <n>] [--json]',
    '  stop --run <id> [--worker <id>]',
    '  roles',
    '',
    `Roles: ${MANAGED_AGENT_TYPES.join(', ')}`,
  ].join('\n') + '\n')
}

async function main() {
  const { command, options, passthrough } = parseArguments(process.argv.slice(2))
  const dataDir = defaultDataDir()
  let result
  if (command === 'create') {
    result = await createRun({
      cwd: options.cwd,
      objective: options.objective,
      runId: options['run-id'],
      qaTier: options['qa-tier'],
      qaProfile: options['qa-profile'],
      dataDir,
    })
  } else if (command === 'spawn') {
    result = await launchWorker({
      runId: options.run,
      workerId: options.worker,
      role: options.role,
      taskFile: options['task-file'],
      allowWrite: options['allow-write'] === true,
      dataDir,
    })
  } else if (command === 'test') {
    result = await runTestEvidence({
      runId: options.run,
      testId: options['test-id'],
      command: passthrough,
      timeoutSeconds: Number(options['timeout-seconds'] || 900),
      dataDir,
    })
    if (result.status !== 'passed') process.exitCode = 1
  } else if (command === 'release') {
    result = await runReleaseEvidence({
      runId: options.run,
      phase: options.phase,
      command: passthrough,
      remote: options.remote || 'origin',
      branch: options.branch,
      target: options.target,
      timeoutSeconds: Number(options['timeout-seconds'] || 900),
      dataDir,
    })
    if (result.status !== 'passed') process.exitCode = 1
  } else if (command === 'close') {
    result = await closeRun({
      runId: options.run,
      solVerdict: options['sol-verdict'],
      acceptWorkerFailures: options['accept-worker-failures'] === true,
      dataDir,
    })
  } else if (command === 'status') {
    result = await getRunStatus({ runId: options.run, dataDir })
  } else if (command === 'wait') {
    result = await waitForWorkers({
      runId: options.run,
      workerId: options.worker,
      timeoutSeconds: Number(options['timeout-seconds'] || 900),
      dataDir,
    })
    if (!result.selectedSuccessful) process.exitCode = 1
  } else if (command === 'stop') {
    result = await stopWorkers({ runId: options.run, workerId: options.worker, dataDir })
  } else if (command === '_worker') {
    result = await runWorker({ runId: options.run, workerId: options.worker, dataDir })
  } else if (command === 'roles') {
    result = Object.fromEntries(MANAGED_AGENT_TYPES.map((name) => [name, resolveManagedAgentRole(name)]))
  } else {
    printHelp()
    if (command !== 'help' && command !== '--help') process.exitCode = 1
    return
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`gpt-5-6-orchestrator: ${error.message}\n`)
    process.exitCode = 1
  })
}

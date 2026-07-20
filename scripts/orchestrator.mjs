#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveOrchestratorDataDir } from '../lib/data-dir.mjs'
import {
  MANAGED_AGENT_TYPES,
  resolveManagedAgentRole,
} from '../lib/routing.mjs'
import {
  findLedger,
  ledgerItemIds,
  parseLedger,
  readLedger,
} from '../lib/ledger.mjs'
import {
  assertContainedPath,
  readContainedBoundedJson,
  validateWorkerProofPath,
} from '../lib/proof.mjs'
import {
  extractTaskObjective,
  HANDOFF_FIELDS,
  validateHandoffReport,
  validateTaskContract as validateDetailedTaskContract,
} from '../lib/task-contract.mjs'
import {
  parseRuntimeProofFile,
  readLatestActivity,
  sanitizeActivityText,
} from '../lib/runtime-events.mjs'
import {
  DEFAULT_SOL_EFFORT,
  normalizeSolEffort,
  readOrchestratorSettings,
  SUPPORTED_SOL_EFFORTS,
  writeOrchestratorSettings,
} from '../lib/settings.mjs'
import {
  captureWorkspaceSnapshot,
  resolveGitWorkspace,
  validateSnapshotOwnership,
} from '../lib/workspace-snapshot.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const TERMINAL_STATES = new Set(['completed', 'failed', 'stopped'])
const MAX_TASK_BYTES = 128 * 1024
const MAX_REPORT_BYTES = 1024 * 1024
const MAX_CONCURRENCY = 8
const DETAILED_TASK_THRESHOLD = 1500
const DEFAULT_EXECUTION_TIMEOUT_SECONDS = 1800
const MAX_EXECUTION_TIMEOUT_SECONDS = 86_400
const PROCESS_HEARTBEAT_STALE_MS = 10_000
const CONTROLLER_LOCK_STALE_MS = 30_000
const TMUX_PANE_MARKER_OPTION = '@gpt56_orchestrator_run'
const TMUX_PANE_TITLE = 'GPT-5.6 agents'
const AUTO_PANE_DISABLED_VALUES = new Set(['0', 'false', 'no', 'off'])
const CONTROLLER_CONTRACT = Object.freeze({
  model: 'gpt-5.6-sol',
  authority: 'main-session',
  attestation: 'declared-main-session-contract',
})
const WORKER_BACKEND = 'codex-exec-background'

export function defaultDataDir(env = process.env) {
  return resolveOrchestratorDataDir({ env, modulePath: SCRIPT_PATH })
}

function assertIdentifier(value, label) {
  if (!IDENTIFIER.test(String(value || ''))) {
    throw new Error(`${label} must match ${IDENTIFIER}`)
  }
  return String(value)
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function assertControllerContract(manifest) {
  const controller = manifest?.controller
  if (
    !controller
    || controller.model !== CONTROLLER_CONTRACT.model
    || !SUPPORTED_SOL_EFFORTS.includes(controller.effort)
    || controller.authority !== CONTROLLER_CONTRACT.authority
    || (manifest.schemaVersion >= 2 && controller.attestation !== CONTROLLER_CONTRACT.attestation)
    || manifest.workerBackend !== WORKER_BACKEND
  ) {
    throw new Error('Invalid Orchestrator run controller contract')
  }
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

async function openPrivateOutput(targetPath) {
  const existing = await optionalStat(targetPath)
  if (existing?.isSymbolicLink()) throw new Error(`Unsafe symlinked worker artifact: ${targetPath}`)
  return open(
    targetPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  )
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

async function withControllerLock(dataDir, callback) {
  await ensurePrivateDirectory(dataDir)
  const lockPath = path.join(dataDir, '.controller-lock')
  const ownerPath = path.join(lockPath, 'owner-token')
  const ownerToken = randomUUID()
  let acquired = false
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      try {
        await writeFile(ownerPath, ownerToken, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      acquired = true
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await optionalStat(lockPath)
      if (info && Date.now() - info.mtimeMs > CONTROLLER_LOCK_STALE_MS) {
        const stalePath = `${lockPath}.stale-${randomUUID()}`
        try {
          await rename(lockPath, stalePath)
          await rm(stalePath, { recursive: true, force: true })
        } catch (staleError) {
          if (!['ENOENT', 'EEXIST'].includes(staleError?.code)) throw staleError
        }
        continue
      }
      await delay(25)
    }
  }
  if (!acquired) throw new Error('Timed out acquiring the Orchestrator controller lock')
  const refreshTimer = setInterval(() => {
    readFile(ownerPath, 'utf8')
      .then((currentToken) => {
        if (currentToken !== ownerToken) return null
        const now = new Date()
        return utimes(lockPath, now, now)
      })
      .catch(() => {})
  }, Math.floor(CONTROLLER_LOCK_STALE_MS / 3))
  refreshTimer.unref?.()
  try {
    return await callback()
  } finally {
    clearInterval(refreshTimer)
    const currentToken = await readFile(ownerPath, 'utf8').catch(() => null)
    if (currentToken === ownerToken) {
      await rm(lockPath, { recursive: true, force: true })
    }
  }
}

function normalizeExecutionTimeout(value) {
  const timeout = Number(value ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS)
  if (
    !Number.isInteger(timeout)
    || timeout < 1
    || timeout > MAX_EXECUTION_TIMEOUT_SECONDS
  ) {
    throw new Error(`execution timeout must be an integer between 1 and ${MAX_EXECUTION_TIMEOUT_SECONDS}`)
  }
  return timeout
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
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

export async function createRun(options) {
  const dataDir = options.dataDir ?? defaultDataDir()
  return withControllerLock(dataDir, () => createRunUnlocked({ ...options, dataDir }))
}

async function createRunUnlocked({ cwd, objective, runId, solEffort, env = process.env, dataDir }) {
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
  await ensurePrivateDirectory(dataDir)
  await ensurePrivateDirectory(runsDir(dataDir))
  const targetRunDir = runDir(dataDir, normalizedRunId)
  if (await optionalStat(targetRunDir)) throw new Error(`Run already exists: ${normalizedRunId}`)
  await mkdir(targetRunDir, { mode: 0o700 })
  await mkdir(path.join(targetRunDir, 'workers'), { mode: 0o700 })
  const configuredSettings = await readOrchestratorSettings(dataDir, { env })
  const effectiveSolEffort = solEffort === undefined
    ? configuredSettings.solEffort
    : normalizeSolEffort(solEffort)
  const manifest = {
    schemaVersion: 2,
    runId: normalizedRunId,
    objective: normalizedObjective,
    cwd: resolvedCwd,
    controller: {
      ...CONTROLLER_CONTRACT,
      effort: effectiveSolEffort,
      effortSource: solEffort === undefined ? configuredSettings.source : 'run-override',
    },
    workerBackend: WORKER_BACKEND,
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
  if (manifest.runId !== runId) {
    throw new Error(`Invalid Orchestrator run manifest: ${targetRunDir}`)
  }
  assertControllerContract(manifest)
  return { ...manifest, runDir: targetRunDir }
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
  const noFollow = constants.O_NOFOLLOW ?? 0
  const sourceHandle = await open(sourcePath, constants.O_RDONLY | noFollow)
  let destinationHandle
  let copiedSuccessfully = false
  try {
    const descriptorInfo = await sourceHandle.stat()
    if (
      !descriptorInfo.isFile()
      || !sameFileIdentity(sourceInfo, descriptorInfo)
      || descriptorInfo.size !== sourceInfo.size
    ) {
      throw new Error('Task file changed while it was being opened')
    }
    destinationHandle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    )
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let copied = 0
    let position = 0
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      copied += bytesRead
      if (copied > MAX_TASK_BYTES) {
        throw new Error(`Task file must contain between 1 and ${MAX_TASK_BYTES} bytes`)
      }
      await destinationHandle.write(buffer, 0, bytesRead)
      position += bytesRead
    }
    const finalDescriptorInfo = await sourceHandle.stat()
    if (
      copied === 0
      || copied !== descriptorInfo.size
      || !sameFileIdentity(descriptorInfo, finalDescriptorInfo)
      || finalDescriptorInfo.size !== descriptorInfo.size
    ) {
      throw new Error('Task file changed while it was being copied')
    }
    await destinationHandle.sync()
    copiedSuccessfully = true
    return resolvedSource
  } finally {
    await sourceHandle.close()
    await destinationHandle?.close()
    if (!copiedSuccessfully) {
      await unlink(destinationPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error
      })
    }
  }
}

export function validateTaskContract({ task, ledger = null }) {
  return validateDetailedTaskContract({
    task,
    detailedThreshold: DETAILED_TASK_THRESHOLD,
    ledger: ledger ? { ids: ledgerItemIds(ledger.content) } : null,
  })
}

async function findRunLedger(cwd) {
  const ledgerPath = await findLedger(cwd)
  if (!ledgerPath) return null
  const content = await readLedger(ledgerPath)
  return { path: ledgerPath, content, parsed: parseLedger(content) }
}

function normalizeOwnsInput(owns) {
  const rawPaths = Array.isArray(owns)
    ? owns
    : typeof owns === 'string' ? owns.split(',') : []
  if (rawPaths.length === 0) throw new Error('Write workers require a non-empty --owns declaration')
  const normalized = []
  for (const rawPath of rawPaths) {
    const value = String(rawPath || '')
    if (!value || value.trim() !== value || value.includes('\0')) {
      throw new Error('Owned paths must be non-empty normalized relative paths')
    }
    const slashPath = value.replaceAll('\\', '/')
    if (
      path.posix.isAbsolute(slashPath)
      || path.win32.isAbsolute(value)
      || slashPath === '.'
      || slashPath.split('/').some((part) => !part || part === '.' || part === '..')
      || /[*?\[\]{}]/.test(slashPath)
      || path.posix.normalize(slashPath) !== slashPath
    ) {
      throw new Error(`Owned path is unsafe or ambiguous: ${value}`)
    }
    normalized.push(slashPath)
  }
  return [...new Set(normalized)].sort()
}

async function assertOwnsPathsSafe(cwd, owns) {
  for (const ownedPath of owns) {
    let current = cwd
    for (const component of ownedPath.split('/')) {
      current = path.join(current, component)
      const info = await optionalStat(current)
      if (!info) break
      if (info.isSymbolicLink()) throw new Error(`Owned path contains a symlinked component: ${ownedPath}`)
    }
  }
}

function ownedPathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function assertWriteOwnershipAvailable(activeWorkers, owns) {
  for (const worker of activeWorkers) {
    if (worker.sandbox !== 'workspace-write') continue
    if (!Array.isArray(worker.owns) || worker.owns.length === 0) {
      throw new Error(`Active write worker ${worker.workerId} has no safe ownership declaration`)
    }
    const activeOwns = normalizeOwnsInput(worker.owns)
    for (const activePath of activeOwns) {
      for (const ownedPath of owns) {
        if (ownedPathsOverlap(activePath, ownedPath)) {
          throw new Error(`Write ownership overlaps active worker ${worker.workerId}: ${ownedPath}`)
        }
      }
    }
  }
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

async function listAllWorkerRecords(dataDir) {
  const root = runsDir(dataDir)
  const rootInfo = await optionalStat(root)
  if (!rootInfo) return []
  await assertContainedPath(root, root, { type: 'directory' })
  const entries = await readdir(root, { withFileTypes: true })
  const records = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Unsafe symlinked run directory: ${entry.name}`)
    if (!entry.isDirectory() || !IDENTIFIER.test(entry.name)) continue
    const run = await loadRun({ runId: entry.name, dataDir })
    for (const worker of await listWorkerRecords({ runId: entry.name, dataDir })) {
      records.push({ ...worker, runCwd: run.cwd })
    }
  }
  return records
}

async function writeWorkerRecord(dataDir, runId, workerId, record) {
  await writeJsonAtomic(path.join(workerDir(dataDir, runId, workerId), 'worker.json'), record)
}

async function verifiedHeartbeat(dataDir, worker, now = Date.now()) {
  const expectedPath = path.join(workerDir(dataDir, worker.runId, worker.workerId), 'heartbeat.json')
  if (worker.heartbeatPath !== expectedPath || !worker.processToken) return null
  try {
    const heartbeat = await readContainedBoundedJson(runsDir(dataDir), expectedPath)
    const atMs = Date.parse(heartbeat.at)
    if (
      heartbeat.processToken !== worker.processToken
      || heartbeat.pid !== worker.pid
      || !Number.isFinite(atMs)
      || now - atMs > PROCESS_HEARTBEAT_STALE_MS
      || !isProcessAlive(Number(heartbeat.pid))
    ) return null
    return heartbeat
  } catch {
    return null
  }
}

async function reconcileWorkerRecordUnlocked(dataDir, worker, now = Date.now()) {
  if (worker.status === 'completed' && worker.schemaVersion >= 2) {
    const validation = await validateWorkerProofPath({
      proofPath: worker.proofPath,
      cwd: worker.runCwd,
      dataDir,
      expectedRunId: worker.runId,
    })
    if (validation.valid) return worker
    const failedAt = new Date(now).toISOString()
    const failed = {
      ...worker,
      status: 'failed',
      error: `completed worker proof is invalid: ${validation.reason}`,
      completedAt: failedAt,
      updatedAt: failedAt,
    }
    await writeWorkerRecord(dataDir, worker.runId, worker.workerId, failed)
    return failed
  }
  if (TERMINAL_STATES.has(worker.status)) return worker
  const updatedAtMs = Date.parse(worker.updatedAt || worker.createdAt)
  const ageMs = Number.isFinite(updatedAtMs) ? now - updatedAtMs : Infinity
  let failure = null
  if (worker.status === 'queued' && ageMs > 30_000) {
    const launcherPid = Number(worker.launcherPid)
    if (!isProcessAlive(launcherPid)) failure = 'queued worker launcher is no longer running'
  } else if (worker.status === 'running') {
    const heartbeat = await verifiedHeartbeat(dataDir, worker, now)
    if (!heartbeat && !isProcessAlive(Number(worker.pid))) {
      failure = 'worker controller process is no longer running'
    }
  }
  if (!failure) return worker
  const failedAt = new Date(now).toISOString()
  const failed = {
    ...worker,
    status: 'failed',
    error: failure,
    completedAt: failedAt,
    updatedAt: failedAt,
  }
  await writeWorkerRecord(dataDir, worker.runId, worker.workerId, failed)
  return failed
}

async function reconcileAllWorkersUnlocked(dataDir) {
  const workers = await listAllWorkerRecords(dataDir)
  const reconciled = []
  for (const worker of workers) {
    reconciled.push({
      ...await reconcileWorkerRecordUnlocked(dataDir, worker),
      runCwd: worker.runCwd,
    })
  }
  return reconciled
}

export async function materializeWorker(options) {
  const dataDir = options.dataDir ?? defaultDataDir()
  return withControllerLock(dataDir, () => materializeWorkerUnlocked({ ...options, dataDir }))
}

async function materializeWorkerUnlocked({
  runId,
  workerId,
  role: roleName,
  taskFile,
  owns,
  allowWrite = false,
  executionTimeoutSeconds = DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  dataDir,
  }) {
  const run = await loadRun({ runId, dataDir })
  const normalizedWorkerId = assertIdentifier(workerId, 'worker id')
  const targetWorkerDir = workerDir(dataDir, runId, normalizedWorkerId)
  if (await optionalStat(targetWorkerDir)) {
    throw new Error(`Worker already exists: ${normalizedWorkerId}`)
  }
  const role = resolveManagedAgentRole(roleName, { solEffort: run.controller.effort })
  if (!role) {
    throw new Error(`Unknown role ${roleName}. Choose one of: ${MANAGED_AGENT_TYPES.join(', ')}`)
  }
  if (role.sandbox === 'workspace-write' && !allowWrite) {
    throw new Error(`${roleName} requires explicit --allow-write approval`)
  }
  if (role.sandbox !== 'workspace-write' && owns !== undefined) {
    throw new Error('Only write workers may declare --owns paths')
  }
  const normalizedOwns = role.sandbox === 'workspace-write' ? normalizeOwnsInput(owns) : []
  const normalizedExecutionTimeout = normalizeExecutionTimeout(executionTimeoutSeconds)
  if (normalizedOwns.length) await assertOwnsPathsSafe(run.cwd, normalizedOwns)
  const workspaceRoot = role.sandbox === 'workspace-write'
    ? (await resolveGitWorkspace(run.cwd)).gitRoot
    : null
  const activeWorkers = (await reconcileAllWorkersUnlocked(dataDir))
    .filter((worker) => !TERMINAL_STATES.has(worker.status))
  if (activeWorkers.length >= MAX_CONCURRENCY) {
    throw new Error(`The controller already has ${MAX_CONCURRENCY} active workers across runs`)
  }
  if (role.sandbox === 'workspace-write') {
    const workspaceWriters = []
    for (const worker of activeWorkers) {
      if (worker.sandbox !== 'workspace-write') continue
      const activeWorkspaceRoot = worker.workspaceRoot
        || (await resolveGitWorkspace(worker.runCwd).catch(() => ({ gitRoot: worker.runCwd }))).gitRoot
      if (activeWorkspaceRoot === workspaceRoot) workspaceWriters.push(worker)
    }
    assertWriteOwnershipAvailable(workspaceWriters, normalizedOwns)
    if (workspaceWriters.length > 0) {
      throw new Error(
        `Workspace already has active write worker ${workspaceWriters[0].workerId}; use a separate Git worktree for parallel writers`,
      )
    }
  }
  await mkdir(targetWorkerDir, { mode: 0o700 })
  const scratchPath = path.join(targetWorkerDir, 'scratch')
  await mkdir(scratchPath, { mode: 0o700 })
  const copiedTaskPath = path.join(targetWorkerDir, 'task.md')
  const reportPath = path.join(targetWorkerDir, 'report.md')
  try {
    const sourceTaskPath = await copyTaskFile({
      sourcePath: path.resolve(taskFile),
      destinationPath: copiedTaskPath,
      cwd: run.cwd,
    })
    const task = await readFile(copiedTaskPath, 'utf8')
    const ledger = await findRunLedger(run.cwd)
    const taskContract = validateTaskContract({ task, ledger })
    const now = new Date().toISOString()
    const record = {
      schemaVersion: 2,
      runId,
      workerId: normalizedWorkerId,
      role: roleName,
      model: role.model,
      effort: role.effort,
      serviceTier: 'fast',
      sandbox: role.sandbox,
      lane: role.lane,
      owns: normalizedOwns,
      workspaceRoot,
      executionTimeoutSeconds: normalizedExecutionTimeout,
      processToken: randomUUID(),
      ledgerPath: ledger?.path ?? null,
      ledgerIds: taskContract.ledgerIds,
      taskSummary: taskContract.objective,
      status: 'queued',
      sourceTaskPath,
      taskPath: copiedTaskPath,
      scratchPath,
      reportPath,
      resultPath: reportPath,
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

export function buildCodexArguments({ role, cwd, outputPath, scratchPath }) {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--disable',
    'remote_plugin',
    '--disable',
    'plugins',
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
  if (role.sandbox === 'workspace-write') {
    args.splice(args.indexOf('-s'), 0, '--add-dir', scratchPath)
  }
  return args
}

function workerPrompt({ run, record, role, task }) {
  const handoff = role.sandbox === 'workspace-write'
    ? `Exact repository ownership: ${record.owns.join(', ')}. Private handoff paths: the controller grants ${record.scratchPath} as an additional writable directory for bulky evidence and captures your final five-field response at ${record.reportPath}. Never write outside the exact ownership list and that scratch directory; Git-visible escape invalidates proof.`
    : `Private handoff path: keep the repository read-only. The controller captures your final five-field response at ${record.reportPath}; use that durable report for evidence and do not attempt to write ${record.scratchPath}.`
  return [
    'You are a bounded worker launched by the GPT-5.6 Orchestrator controller.',
    `The main interactive session owns planning, task assignment, every consequential decision, and final acceptance; its configured Sol reasoning target for this run is ${run.controller.effort}.`,
    `Run objective: ${run.objective}`,
    `Worker role: ${record.role}`,
    `Requested launch contract: ${role.model}, reasoning effort ${role.effort}, service tier fast, sandbox ${role.sandbox}, hard timeout ${record.executionTimeoutSeconds} seconds.`,
    `Role contract: ${role.instructions}`,
    handoff,
    '',
    'Bounded task:',
    task,
  ].join('\n')
}

async function reportEvidence(outputPath) {
  try {
    const info = await lstat(outputPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_REPORT_BYTES) {
      return { valid: false, size: info.size, reason: 'report must be a bounded regular non-symlink file' }
    }
    const content = await readFile(outputPath, 'utf8')
    const contract = validateHandoffReport(content)
    return {
      ...contract,
      size: info.size,
      sha256: createHash('sha256').update(content).digest('hex'),
    }
  } catch (error) {
    return { valid: false, size: 0, reason: error.message }
  }
}

async function startHeartbeat({ dataDir, record, heartbeatPath }) {
  let stopped = false
  let timer = null
  const write = async () => {
    if (stopped) return
    await writeJsonAtomic(heartbeatPath, {
      schemaVersion: 1,
      runId: record.runId,
      workerId: record.workerId,
      processToken: record.processToken,
      pid: process.pid,
      at: new Date().toISOString(),
    })
    if (!stopped) {
      timer = setTimeout(() => { write().catch(() => {}) }, 1_000)
      timer.unref?.()
    }
  }
  await write()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

export async function runWorker({ runId, workerId, dataDir = defaultDataDir(), env = process.env }) {
  const run = await loadRun({ runId, dataDir })
  const targetWorkerDir = workerDir(dataDir, runId, workerId)
  let record = await readContainedBoundedJson(
    runsDir(dataDir),
    path.join(targetWorkerDir, 'worker.json'),
  )
  if (
    record.runId !== runId
    || record.workerId !== workerId
    || record.taskPath !== path.join(targetWorkerDir, 'task.md')
    || record.scratchPath !== path.join(targetWorkerDir, 'scratch')
    || record.reportPath !== path.join(targetWorkerDir, 'report.md')
    || record.resultPath !== record.reportPath
  ) throw new Error(`Worker handoff paths do not match its identity: ${workerId}`)
  await assertContainedPath(runsDir(dataDir), targetWorkerDir, { type: 'directory' })
  await assertContainedPath(runsDir(dataDir), record.taskPath, { type: 'file' })
  await assertContainedPath(runsDir(dataDir), record.scratchPath, { type: 'directory' })
  if (record.status !== 'queued') throw new Error(`Worker is not queued: ${workerId}`)
  const role = resolveManagedAgentRole(record.role, { solEffort: run.controller.effort })
  if (
    !role
    || role.model !== record.model
    || role.effort !== record.effort
    || role.sandbox !== record.sandbox
    || record.serviceTier !== 'fast'
  ) {
    throw new Error(`Worker role pin does not match its manifest: ${workerId}`)
  }
  const startedAt = new Date().toISOString()
  const eventsPath = path.join(targetWorkerDir, 'events.jsonl')
  const stderrPath = path.join(targetWorkerDir, 'stderr.log')
  const heartbeatPath = path.join(targetWorkerDir, 'heartbeat.json')
  const baselinePath = path.join(targetWorkerDir, 'workspace-baseline.json')
  const outputPath = record.reportPath
  if (await optionalStat(outputPath)) {
    throw new Error(`Worker report path must not already exist: ${outputPath}`)
  }
  let baseline = null
  if (role.sandbox === 'workspace-write') {
    baseline = await captureWorkspaceSnapshot({
      cwd: run.cwd,
      extraPaths: [record.ledgerPath, record.sourceTaskPath],
    })
    await writeJsonAtomic(baselinePath, baseline)
  }
  record = await withControllerLock(dataDir, async () => {
    const current = await readContainedBoundedJson(
      runsDir(dataDir),
      path.join(targetWorkerDir, 'worker.json'),
    )
    if (current.status !== 'queued') throw new Error(`Worker is not queued: ${workerId}`)
    const running = {
      ...current,
      status: 'running',
      backend: WORKER_BACKEND,
      startedAt,
      updatedAt: startedAt,
      pid: process.pid,
      heartbeatPath,
      eventsPath,
      stderrPath,
      baselinePath: baseline ? baselinePath : null,
    }
    await writeWorkerRecord(dataDir, runId, workerId, running)
    return running
  })
  const task = await readFile(record.taskPath, 'utf8')
  const prompt = workerPrompt({ run, record, role, task })
  const args = buildCodexArguments({
    role,
    cwd: run.cwd,
    outputPath,
    scratchPath: record.scratchPath,
  })
  const codexBin = env.GPT56_ORCHESTRATOR_CODEX_BIN || 'codex'
  let eventsHandle
  let stderrHandle
  let stopHeartbeat = null
  let child = null
  let timeoutTimer = null
  let forceTimer = null
  let terminationReason = null
  const requestTermination = (reason, signal = 'SIGTERM') => {
    terminationReason ||= reason
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.kill(signal)
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2_000)
      forceTimer.unref?.()
    }
  }
  const onSigterm = () => requestTermination('controller-stop', 'SIGTERM')
  const onSigint = () => requestTermination('controller-interrupt', 'SIGINT')
  try {
    stopHeartbeat = await startHeartbeat({ dataDir, record, heartbeatPath })
    eventsHandle = await openPrivateOutput(eventsPath)
    stderrHandle = await openPrivateOutput(stderrPath)
    const workerEnv = {
      ...env,
      GPT56_ORCHESTRATOR_DISABLE: '1',
    }
    const recursionGuard = {
      multiAgentDisabled: args.includes('features.multi_agent=false'),
      pluginsDisabled: args.some((arg, index) => arg === '--disable' && args[index + 1] === 'plugins'),
      orchestratorHooksDisabled: workerEnv.GPT56_ORCHESTRATOR_DISABLE === '1',
    }
    child = spawn(codexBin, args, {
      cwd: run.cwd,
      env: workerEnv,
      stdio: ['pipe', eventsHandle.fd, stderrHandle.fd],
    })
    process.once('SIGTERM', onSigterm)
    process.once('SIGINT', onSigint)
    timeoutTimer = setTimeout(
      () => requestTermination('execution-timeout'),
      record.executionTimeoutSeconds * 1_000,
    )
    timeoutTimer.unref?.()
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
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (forceTimer) clearTimeout(forceTimer)
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('SIGINT', onSigint)
    stopHeartbeat?.()
    stopHeartbeat = null
    const runtime = await parseRuntimeProofFile(eventsPath).catch((error) => ({
      threadId: null,
      threadIds: [],
      threadStartCount: 0,
      completed: false,
      completionCount: 0,
      validLifecycle: false,
      usage: null,
      eventCount: 0,
      malformedLines: 0,
      bytes: 0,
      error: error.message,
    }))
    const report = await reportEvidence(outputPath)
    let ownership = {
      mode: role.sandbox === 'workspace-write'
        ? 'git-visible-plus-workflow-contracts'
        : 'read-only-sandbox',
      valid: true,
      changedPaths: [],
      outsidePaths: [],
    }
    if (baseline) {
      try {
        const after = await captureWorkspaceSnapshot({
          cwd: run.cwd,
          extraPaths: [record.ledgerPath, record.sourceTaskPath],
        })
        ownership = {
          mode: 'git-visible-plus-workflow-contracts',
          ...validateSnapshotOwnership({ before: baseline, after, owns: record.owns }),
        }
      } catch (error) {
        ownership = {
          mode: 'git-visible-plus-workflow-contracts',
          valid: false,
          changedPaths: [],
          outsidePaths: [],
          error: error.message,
        }
      }
    }
    const success = outcome.code === 0
      && outcome.signal === null
      && terminationReason === null
      && runtime.validLifecycle
      && recursionGuard.multiAgentDisabled
      && recursionGuard.orchestratorHooksDisabled
      && report.valid
      && ownership.valid
    const completedAt = new Date().toISOString()
    const proofPath = path.join(targetWorkerDir, 'proof.json')
    const proofBase = {
      schemaVersion: 3,
      runId,
      workerId,
      role: record.role,
      backend: WORKER_BACKEND,
      model: role.model,
      effort: role.effort,
      serviceTier: 'fast',
      sandbox: role.sandbox,
      threadId: runtime.threadId,
      runtimeCompleted: runtime.completed,
      recursionGuard,
      exitCode: outcome.code,
      signal: outcome.signal,
      usage: runtime.usage,
      launchContract: {
        source: 'controller-cli-request',
        model: role.model,
        effort: role.effort,
        serviceTier: 'fast',
        sandbox: role.sandbox,
      },
      runtimeEvidence: {
        source: 'codex-json-events',
        modelObserved: false,
        effortObserved: false,
        threadIds: runtime.threadIds,
        threadStartCount: runtime.threadStartCount,
        completionCount: runtime.completionCount,
        eventCount: runtime.eventCount,
        malformedLines: runtime.malformedLines,
        bytes: runtime.bytes,
        lifecycleValid: runtime.validLifecycle,
        error: runtime.error ?? null,
      },
      reportContract: report,
      ownership,
      terminationReason,
      startedAt,
      completedAt,
      taskPath: record.taskPath,
      scratchPath: record.scratchPath,
      reportPath: outputPath,
      resultPath: outputPath,
      eventsPath,
      stderrPath,
      baselinePath: baseline ? baselinePath : null,
    }
    const finalized = await withControllerLock(dataDir, async () => {
      const current = await readContainedBoundedJson(
        runsDir(dataDir),
        path.join(targetWorkerDir, 'worker.json'),
      )
      const finalStatus = current.status === 'stopped' ? 'stopped' : success ? 'completed' : 'failed'
      const proof = { ...proofBase, status: finalStatus }
      await writeJsonAtomic(proofPath, proof)
      const finalRecord = {
        ...(current.status === 'stopped' ? current : record),
        status: finalStatus,
        threadId: proof.threadId,
        completedAt,
        updatedAt: completedAt,
        proofPath,
        resultPath: outputPath,
        reportPath: outputPath,
        scratchPath: record.scratchPath,
        eventsPath,
        stderrPath,
      }
      await writeWorkerRecord(dataDir, runId, workerId, finalRecord)
      return { finalRecord, proof }
    })
    record = finalized.finalRecord
    const proof = finalized.proof
    const finalStatus = proof.status
    if (!success || finalStatus !== 'completed') {
      const reason = finalStatus === 'stopped'
        ? 'was stopped'
        : terminationReason === 'execution-timeout'
          ? `exceeded ${record.executionTimeoutSeconds} seconds`
          : 'failed runtime, handoff, or ownership proof validation'
      throw new Error(`Worker ${workerId} ${reason}`)
    }
    return { ...proof, proofPath }
  } catch (error) {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (forceTimer) clearTimeout(forceTimer)
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('SIGINT', onSigint)
    stopHeartbeat?.()
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
  owns,
  allowWrite = false,
  executionTimeoutSeconds = DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  dataDir = defaultDataDir(),
  env = process.env,
}) {
  const run = await loadRun({ runId, dataDir })
  const record = await materializeWorker({
    runId,
    workerId,
    role,
    taskFile,
    owns,
    allowWrite,
    executionTimeoutSeconds,
    dataDir,
  })
  const visibility = await ensureAutoTmuxPane({ runId, dataDir, env })
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
    await withControllerLock(dataDir, async () => {
      const current = await readContainedBoundedJson(
        runsDir(dataDir),
        path.join(workerDir(dataDir, runId, workerId), 'worker.json'),
      )
      if (current.status !== 'queued') return
      const launchRequestedAt = new Date().toISOString()
      await writeWorkerRecord(dataDir, runId, workerId, {
        ...current,
        launcherPid: child.pid,
        launchRequestedAt,
        updatedAt: launchRequestedAt,
      })
    })
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
    backend: WORKER_BACKEND,
    processId: child.pid,
    visibility,
    proofRequired: path.join(workerDir(dataDir, runId, workerId), 'proof.json'),
    scratchPath: record.scratchPath,
    reportPath: record.reportPath,
  }
}

export async function getRunStatus({ runId, dataDir = defaultDataDir() }) {
  const { run, records } = await withControllerLock(dataDir, async () => {
    const loadedRun = await loadRun({ runId, dataDir })
    const workers = await reconcileAllWorkersUnlocked(dataDir)
    return { run: loadedRun, records: workers.filter((worker) => worker.runId === runId) }
  })
  const workers = await Promise.all(records.map(async (worker) => {
    const {
      processToken: _processToken,
      runCwd: _runCwd,
      ...publicRecord
    } = worker
    const activity = worker.eventsPath ? await readLatestActivity(worker.eventsPath) : null
    let taskSummary = worker.taskSummary || null
    if (!taskSummary && worker.taskPath) {
      try {
        const expectedTaskPath = path.join(workerDir(dataDir, runId, worker.workerId), 'task.md')
        if (worker.taskPath === expectedTaskPath) {
          await assertContainedPath(runsDir(dataDir), expectedTaskPath, { type: 'file' })
          const taskInfo = await lstat(expectedTaskPath)
          if (taskInfo.isFile() && !taskInfo.isSymbolicLink() && taskInfo.size <= MAX_TASK_BYTES) {
            taskSummary = extractTaskObjective(await readFile(expectedTaskPath, 'utf8'))
          }
        }
      } catch {
        taskSummary = null
      }
    }
    const startedAtMs = Date.parse(worker.startedAt)
    const endedAtMs = Date.parse(worker.completedAt)
    return {
      ...publicRecord,
      activity,
      taskSummary,
      elapsedMs: Number.isFinite(startedAtMs)
        ? Math.max(0, (Number.isFinite(endedAtMs) ? endedAtMs : Date.now()) - startedAtMs)
        : null,
    }
  }))
  const counts = workers.reduce((result, worker) => {
    result[worker.status] = (result[worker.status] || 0) + 1
    return result
  }, {})
  return {
    runId,
    objective: run.objective,
    cwd: run.cwd,
    controller: run.controller,
    workerBackend: run.workerBackend,
    complete: workers.length > 0 && workers.every((worker) => TERMINAL_STATES.has(worker.status)),
    successful: workers.length > 0 && workers.every((worker) => worker.status === 'completed'),
    counts,
    workers,
  }
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
  const outcome = await withControllerLock(dataDir, async () => {
    await loadRun({ runId, dataDir })
    const workers = await reconcileAllWorkersUnlocked(dataDir)
    const runWorkers = workers.filter((worker) => worker.runId === runId)
    const selected = workerId
      ? runWorkers.filter((worker) => worker.workerId === workerId)
      : runWorkers
    if (workerId && selected.length === 0) throw new Error(`Unknown worker: ${workerId}`)
    const stoppedAt = new Date().toISOString()
    const stopped = []
    const signals = []
    for (const worker of selected) {
      if (TERMINAL_STATES.has(worker.status)) continue
      const heartbeat = await verifiedHeartbeat(dataDir, worker)
      await writeWorkerRecord(dataDir, runId, worker.workerId, {
        ...worker,
        status: 'stopped',
        stopRequestedAt: stoppedAt,
        completedAt: stoppedAt,
        updatedAt: stoppedAt,
        stopSignalVerified: Boolean(heartbeat),
      })
      if (heartbeat) signals.push({ workerId: worker.workerId, pid: heartbeat.pid })
      stopped.push(worker.workerId)
    }
    return { stopped, signals }
  })
  const signaled = []
  for (const target of outcome.signals) {
    try {
      process.kill(target.pid, 'SIGTERM')
      signaled.push(target.workerId)
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  return { runId, stopped: outcome.stopped, signaled }
}

const DASHBOARD_STATUS_LABELS = Object.freeze({
  queued: 'WAITING',
  running: 'RUNNING',
  completed: 'DONE',
  failed: 'FAILED',
  stopped: 'STOPPED',
})

const DASHBOARD_ACTIVITY_MARKERS = Object.freeze({
  running: '›',
  completed: '✓',
  failed: '!',
  info: '•',
})

function dashboardWidth(value) {
  const width = Number(value)
  if (!Number.isFinite(width)) return 100
  return Math.max(32, Math.min(160, Math.floor(width)))
}

function dashboardElapsed(value) {
  if (!Number.isFinite(value)) return '-'
  const seconds = Math.max(0, Math.round(value / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

function wrapDashboardText(value, width) {
  const normalized = sanitizeActivityText(value, 600) || '-'
  const words = normalized.split(' ')
  const lines = []
  let current = ''
  for (const originalWord of words) {
    let word = originalWord
    while (word.length > width) {
      if (current) {
        lines.push(current)
        current = ''
      }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!word) continue
    if (!current) current = word
    else if (current.length + word.length + 1 <= width) current += ` ${word}`
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['-']
}

function dashboardField(label, value, width, labelWidth = 12) {
  const prefix = `${label}:`.padEnd(labelWidth)
  const available = Math.max(20, width - prefix.length)
  return wrapDashboardText(value, available).map((line, index) => (
    `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`
  ))
}

function dashboardModel(worker) {
  const model = String(worker.model || '')
  const family = model.includes('luna') ? 'Luna' : model.includes('terra') ? 'Terra' : model.includes('sol') ? 'Sol' : model
  const access = worker.sandbox === 'read-only' ? 'read-only' : 'workspace write'
  return `GPT-5.6 ${family} · ${worker.effort || '-'} reasoning · ${access}`
}

function currentWorkerActivity(worker) {
  if (worker.status === 'queued') return 'Waiting for an execution slot'
  if (worker.status === 'completed') return 'Task completed; the handoff report is ready'
  if (worker.status === 'failed') return 'Task failed; main Sol will inspect the failure evidence'
  if (worker.status === 'stopped') return 'Task was stopped by main Sol'
  return worker.activity?.summary || 'Starting up and reading the assigned task'
}

function dashboardActivityLines(worker, width) {
  const recent = Array.isArray(worker.activity?.recent) ? worker.activity.recent.slice(-5) : []
  if (recent.length === 0) {
    const prefix = '  · '
    return wrapDashboardText('No tool activity recorded yet', Math.max(20, width - prefix.length))
      .map((line, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`)
  }
  const lines = []
  for (const activity of recent) {
    const marker = DASHBOARD_ACTIVITY_MARKERS[activity.state] || '·'
    const prefix = `  ${marker} `
    const available = Math.max(20, width - prefix.length)
    const wrapped = wrapDashboardText(activity.summary, available)
    lines.push(...wrapped.map((line, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`))
  }
  return lines
}

export function renderDashboard(status, { width = 100 } = {}) {
  const columns = dashboardWidth(width)
  const divider = '─'.repeat(columns)
  const workers = Array.isArray(status.workers) ? status.workers : []
  const counts = ['running', 'queued', 'completed', 'failed', 'stopped']
    .filter((state) => Number(status.counts?.[state]) > 0)
    .map((state) => `${status.counts[state]} ${state}`)
    .join(' · ') || 'no agents yet'
  const output = [
    'GPT-5.6 AGENT TEAM — LIVE WORK',
    ...dashboardField('Run', status.runId, columns),
    ...dashboardField('Goal', status.objective, columns),
    ...dashboardField('Progress', counts, columns),
    ...dashboardField('Controller', `Sol · ${status.controller.effort} reasoning · main-session authority`, columns),
  ]

  if (workers.length === 0) {
    output.push(divider, ...wrapDashboardText('No agents have been started for this run.', columns))
  }

  workers.forEach((worker, index) => {
    const statusLabel = DASHBOARD_STATUS_LABELS[worker.status] || String(worker.status || 'UNKNOWN').toUpperCase()
    const task = worker.taskSummary || status.objective || 'No task summary available'
    const lane = String(worker.lane || '').replaceAll('-', ' ') || 'Bounded assigned work'
    const reportName = worker.reportPath ? path.basename(worker.reportPath) : 'report.md'
    const reportState = worker.status === 'completed'
      ? `Ready: ${reportName}`
      : worker.status === 'failed' || worker.status === 'stopped'
        ? `Not accepted: ${reportName}`
        : `Pending: ${reportName}`
    const workerHeading = `[${index + 1}/${workers.length}] ${sanitizeActivityText(worker.workerId, 80) || 'agent'}  ·  ${statusLabel}  ·  ${dashboardElapsed(worker.elapsedMs)}`
    output.push(
      divider,
      ...wrapDashboardText(workerHeading, columns),
      ...dashboardField('Agent', dashboardModel(worker), columns),
      ...dashboardField('Role', lane, columns),
      ...dashboardField('Task', task, columns),
      ...dashboardField('Now', currentWorkerActivity(worker), columns),
      'Recent work:',
      ...dashboardActivityLines(worker, columns),
    )
    if (worker.owns?.length) output.push(...dashboardField('Owns', worker.owns.join(', '), columns))
    output.push(...dashboardField('Report', reportState, columns))
  })

  output.push(divider, ...wrapDashboardText('Updates automatically. The pane closes when every agent reaches a terminal state.', columns))
  return output.join('\n')
}

function normalizeIntervalMs(value) {
  const interval = Number(value ?? 1000)
  if (!Number.isInteger(interval) || interval < 10 || interval > 3_600_000) {
    throw new Error('interval-ms must be an integer between 10 and 3600000')
  }
  return interval
}

function normalizePaneWidth(value) {
  const width = Number(value ?? 40)
  if (!Number.isInteger(width) || width < 20 || width > 80) {
    throw new Error('width must be an integer percentage between 20 and 80')
  }
  return width
}

export async function runDashboard({
  runId,
  watch = false,
  keepOpen = false,
  intervalMs = 1000,
  dataDir = defaultDataDir(),
  write = (value) => process.stdout.write(value),
}) {
  const normalizedInterval = normalizeIntervalMs(intervalMs)
  do {
    const status = await getRunStatus({ runId, dataDir })
    if (watch) write('\x1Bc')
    write(`${renderDashboard(status, { width: process.stdout.columns })}\n`)
    if (!watch || (status.complete && !keepOpen)) return status
    await delay(normalizedInterval)
  } while (watch)
  return null
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`
}

export function buildPaneDashboardCommand({
  runId,
  intervalMs = 1000,
  nodeBin = process.execPath,
  dataDir = null,
}) {
  const normalizedRunId = assertIdentifier(runId, 'run id')
  const normalizedInterval = normalizeIntervalMs(intervalMs)
  const command = dataDir
    ? ['env', `GPT56_ORCHESTRATOR_DATA_DIR=${path.resolve(dataDir)}`, nodeBin]
    : [nodeBin]
  return [...command, SCRIPT_PATH, 'dashboard', '--run', normalizedRunId, '--watch', '--interval-ms', normalizedInterval]
    .map(shellQuote)
    .join(' ')
}

function runChild(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function tmuxPaneMarker({ runId, dataDir }) {
  return createHash('sha256')
    .update(`${path.resolve(dataDir)}\0${assertIdentifier(runId, 'run id')}`)
    .digest('hex')
}

async function findTmuxDashboardPane({ runId, dataDir, env }) {
  const tmuxBin = env.GPT56_ORCHESTRATOR_TMUX_BIN || 'tmux'
  const marker = tmuxPaneMarker({ runId, dataDir })
  const listArgs = ['list-panes']
  if (env.TMUX_PANE) listArgs.push('-t', env.TMUX_PANE)
  listArgs.push('-F', `#{pane_id}\t#{${TMUX_PANE_MARKER_OPTION}}`)
  const listed = await runChild(tmuxBin, listArgs, { env })
  if (listed.code !== 0) {
    throw new Error(`Unable to inspect tmux dashboard panes: ${listed.stderr.trim() || 'tmux list-panes failed'}`)
  }
  for (const line of listed.stdout.split('\n')) {
    const [paneId, paneMarker] = line.split('\t')
    if (paneId && paneMarker === marker) return paneId
  }
  return null
}

export async function openTmuxPane({
  runId,
  width = 40,
  intervalMs = 1000,
  dataDir = null,
  env = process.env,
}) {
  const normalizedRunId = assertIdentifier(runId, 'run id')
  if (!env.TMUX) throw new Error('pane requires an existing tmux client; run it from inside tmux')
  const normalizedWidth = normalizePaneWidth(width)
  const normalizedInterval = normalizeIntervalMs(intervalMs)
  const resolvedDataDir = dataDir ? path.resolve(dataDir) : defaultDataDir(env)
  const tmuxBin = env.GPT56_ORCHESTRATOR_TMUX_BIN || 'tmux'
  let client
  try {
    client = await runChild(tmuxBin, ['display-message', '-p', '#{client_tty}'], { env })
  } catch (error) {
    throw new Error(`pane requires an existing tmux client: ${error.message}`)
  }
  if (client.code !== 0 || !client.stdout.trim()) {
    throw new Error(`pane requires an existing tmux client: ${client.stderr.trim() || 'tmux has no attached client'}`)
  }
  const command = buildPaneDashboardCommand({
    runId,
    intervalMs: normalizedInterval,
    nodeBin: env.GPT56_ORCHESTRATOR_NODE_BIN || process.execPath,
    dataDir: resolvedDataDir,
  })
  const splitArgs = ['split-window']
  if (env.TMUX_PANE) splitArgs.push('-t', env.TMUX_PANE)
  splitArgs.push(
    '-h', '-d', '-p', String(normalizedWidth),
    '-P', '-F', '#{pane_id}', command,
  )
  const created = await runChild(tmuxBin, splitArgs, { env })
  if (created.code !== 0) throw new Error(`Unable to open tmux dashboard pane: ${created.stderr.trim() || 'tmux split failed'}`)
  const paneId = created.stdout.trim() || null
  if (paneId) {
    const marker = tmuxPaneMarker({ runId: normalizedRunId, dataDir: resolvedDataDir })
    const marked = await runChild(tmuxBin, [
      'set-option', '-p', '-t', paneId, TMUX_PANE_MARKER_OPTION, marker,
    ], { env })
    if (marked.code !== 0) {
      await runChild(tmuxBin, ['kill-pane', '-t', paneId], { env }).catch(() => {})
      throw new Error(`Unable to mark tmux dashboard pane: ${marked.stderr.trim() || 'tmux set-option failed'}`)
    }
    await runChild(tmuxBin, ['select-pane', '-t', paneId, '-T', TMUX_PANE_TITLE], { env })
      .catch(() => {})
  }
  return { runId: normalizedRunId, paneId, width: normalizedWidth, intervalMs: normalizedInterval, command }
}

export async function ensureAutoTmuxPane({
  runId,
  width = 40,
  intervalMs = 1000,
  dataDir = null,
  env = process.env,
}) {
  const autoPaneSetting = String(env.GPT56_ORCHESTRATOR_AUTO_PANE ?? '').trim().toLowerCase()
  if (AUTO_PANE_DISABLED_VALUES.has(autoPaneSetting)) {
    return { status: 'skipped', reason: 'disabled' }
  }
  if (!env.TMUX) return { status: 'skipped', reason: 'not-in-tmux' }
  try {
    const normalizedRunId = assertIdentifier(runId, 'run id')
    const resolvedDataDir = dataDir ? path.resolve(dataDir) : defaultDataDir(env)
    return await withControllerLock(resolvedDataDir, async () => {
      const existingPaneId = await findTmuxDashboardPane({
        runId: normalizedRunId,
        dataDir: resolvedDataDir,
        env,
      })
      if (existingPaneId) {
        return { status: 'reused', runId: normalizedRunId, paneId: existingPaneId }
      }
      const opened = await openTmuxPane({
        runId: normalizedRunId,
        width,
        intervalMs,
        dataDir: resolvedDataDir,
        env,
      })
      return { status: 'opened', ...opened }
    })
  } catch (error) {
    return { status: 'failed', error: error.message }
  }
}

export async function pruneRuns({
  olderThanHours,
  apply = false,
  dataDir = defaultDataDir(),
  now = Date.now(),
}) {
  const hours = Number(olderThanHours)
  if (!Number.isInteger(hours) || hours < 1 || hours > 87_600) {
    throw new Error('older-than-hours must be an integer between 1 and 87600')
  }
  return withControllerLock(dataDir, async () => {
    const workers = await reconcileAllWorkersUnlocked(dataDir)
    const workerGroups = new Map()
    for (const worker of workers) {
      const group = workerGroups.get(worker.runId) || []
      group.push(worker)
      workerGroups.set(worker.runId, group)
    }
    const root = runsDir(dataDir)
    if (!await optionalStat(root)) {
      return {
        dryRun: !apply,
        olderThanHours: hours,
        candidates: [],
        skippedActive: [],
        moved: [],
        recoverableFrom: path.join(dataDir, 'trash'),
      }
    }
    const entries = await readdir(root, { withFileTypes: true })
    const cutoff = now - hours * 60 * 60 * 1000
    const candidates = []
    const skippedActive = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Unsafe symlinked run directory: ${entry.name}`)
      if (!entry.isDirectory() || !IDENTIFIER.test(entry.name)) continue
      const run = await loadRun({ runId: entry.name, dataDir })
      const runWorkers = workerGroups.get(entry.name) || []
      if (runWorkers.some((worker) => !TERMINAL_STATES.has(worker.status))) {
        skippedActive.push(entry.name)
        continue
      }
      const timestamps = [run.createdAt, ...runWorkers.flatMap((worker) => [
        worker.updatedAt,
        worker.completedAt,
      ])]
        .map(Date.parse)
        .filter(Number.isFinite)
      const latest = timestamps.length ? Math.max(...timestamps) : Infinity
      if (latest <= cutoff) candidates.push(entry.name)
    }
    const moved = []
    if (apply && candidates.length > 0) {
      const trashRoot = path.join(dataDir, 'trash')
      await ensurePrivateDirectory(trashRoot)
      for (const runId of candidates) {
        const source = runDir(dataDir, runId)
        await assertContainedPath(root, source, { type: 'directory' })
        const destination = path.join(trashRoot, `${runId}-${timestampId()}-${randomUUID().slice(0, 8)}`)
        await rename(source, destination)
        moved.push({ runId, destination })
      }
    }
    return {
      dryRun: !apply,
      olderThanHours: hours,
      candidates,
      skippedActive,
      moved,
      recoverableFrom: path.join(dataDir, 'trash'),
    }
  })
}

function parseArguments(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    if (['allow-write', 'apply', 'json', 'keep-open', 'watch'].includes(key)) {
      options[key] = true
      continue
    }
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
    options[key] = value
    index += 1
  }
  return { command, options }
}

function printHelp() {
  process.stdout.write([
    'GPT-5.6 Orchestrator Codex worker controller',
    '',
    'Commands:',
    `  create --cwd <dir> --objective <text> [--run-id <id>] [--sol-effort <${SUPPORTED_SOL_EFFORTS.join('|')}>]`,
    '  spawn --run <id> --worker <id> --role <role> --task-file <path> [--allow-write --owns <path[,path]>] [--execution-timeout-seconds <n>]',
    '  status --run <id> [--json]',
    '  dashboard --run <id> [--watch] [--keep-open] [--interval-ms <n>]',
    '  pane --run <id> [--width <percent>] [--interval-ms <n>]',
    '  wait --run <id> [--worker <id>] [--timeout-seconds <n>] [--json]',
    '  stop --run <id> [--worker <id>]',
    '  prune --older-than-hours <n> [--apply]',
    `  config [--sol-effort <${SUPPORTED_SOL_EFFORTS.join('|')}>]`,
    '  data-dir',
    '  roles',
    '',
    `Roles: ${MANAGED_AGENT_TYPES.join(', ')}`,
    '',
    'Tmux: spawn automatically opens one right-side live-work panel with human-readable agent tasks and recent activity; it closes when the run is terminal.',
    'Set GPT56_ORCHESTRATOR_AUTO_PANE=0 to disable automatic panes; pane --run remains available for recovery.',
  ].join('\n') + '\n')
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2))
  const dataDir = defaultDataDir()
  let result
  if (command === 'create') {
    result = await createRun({
      cwd: options.cwd,
      objective: options.objective,
      runId: options['run-id'],
      solEffort: options['sol-effort'],
      env: process.env,
      dataDir,
    })
  } else if (command === 'spawn') {
    result = await launchWorker({
      runId: options.run,
      workerId: options.worker,
      role: options.role,
      taskFile: options['task-file'],
      owns: options.owns,
      allowWrite: options['allow-write'] === true,
      executionTimeoutSeconds: options['execution-timeout-seconds'] || DEFAULT_EXECUTION_TIMEOUT_SECONDS,
      dataDir,
    })
  } else if (command === 'status') {
    result = await getRunStatus({ runId: options.run, dataDir })
  } else if (command === 'dashboard') {
    await runDashboard({
      runId: options.run,
      watch: options.watch === true,
      keepOpen: options['keep-open'] === true,
      intervalMs: options['interval-ms'] || 1000,
      dataDir,
    })
    return
  } else if (command === 'pane') {
    result = await openTmuxPane({
      runId: options.run,
      width: options.width || 40,
      intervalMs: options['interval-ms'] || 1000,
      dataDir,
    })
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
  } else if (command === 'prune') {
    result = await pruneRuns({
      olderThanHours: options['older-than-hours'],
      apply: options.apply === true,
      dataDir,
    })
  } else if (command === 'config') {
    const settings = options['sol-effort'] === undefined
      ? await readOrchestratorSettings(dataDir)
      : await writeOrchestratorSettings(dataDir, { solEffort: options['sol-effort'] })
    result = {
      ...settings,
      defaultSolEffort: DEFAULT_SOL_EFFORT,
      allowedSolEfforts: SUPPORTED_SOL_EFFORTS,
      mainSession: {
        currentChat: '/reasoning',
        durableConfig: `model_reasoning_effort = "${settings.solEffort}"`,
        oneOff: `codex -m gpt-5.6-sol -c 'model_reasoning_effort="${settings.solEffort}"' -c 'service_tier="fast"'`,
        note: 'Plugin settings define the orchestration target and delegated Sol effort; Codex controls the active main-session effort.',
      },
    }
  } else if (command === 'data-dir') {
    result = { dataDir }
  } else if (command === '_worker') {
    result = await runWorker({ runId: options.run, workerId: options.worker, dataDir })
  } else if (command === 'roles') {
    const settings = await readOrchestratorSettings(dataDir)
    result = Object.fromEntries(MANAGED_AGENT_TYPES.map((name) => [
      name,
      resolveManagedAgentRole(name, { solEffort: settings.solEffort }),
    ]))
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

#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
} from '../lib/proof.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const TERMINAL_STATES = new Set(['completed', 'failed', 'stopped'])
const MAX_TASK_BYTES = 128 * 1024
const MAX_CONCURRENCY = 8
const DETAILED_TASK_THRESHOLD = 1500
const CONTROLLER_CONTRACT = Object.freeze({
  model: 'gpt-5.6-sol',
  effort: 'max',
  authority: 'main-session',
})
const WORKER_BACKEND = 'codex-exec-background'
const HANDOFF_FIELDS = Object.freeze([
  'Ledger items addressed and scope',
  'Evidence and files changed',
  'Verification result',
  'Risks and unresolved issues',
  'Confidence and out-of-scope findings',
])

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

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function assertControllerContract(manifest) {
  const controller = manifest?.controller
  if (
    !controller
    || controller.model !== CONTROLLER_CONTRACT.model
    || controller.effort !== CONTROLLER_CONTRACT.effort
    || controller.authority !== CONTROLLER_CONTRACT.authority
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

export async function createRun({ cwd, objective, runId, dataDir = defaultDataDir() }) {
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
  const manifest = {
    schemaVersion: 1,
    runId: normalizedRunId,
    objective: normalizedObjective,
    cwd: resolvedCwd,
    controller: {
      ...CONTROLLER_CONTRACT,
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

function sectionValue(task, names) {
  const lines = String(task).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*#*\s*([^:\n]+):\s*(.*)$/)
    if (!match || !names.includes(match[1].trim().toLowerCase())) continue
    const values = [match[2].trim()].filter(Boolean)
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^\s*#*\s*[^:\n]+:\s*/.test(lines[next])) break
      if (lines[next].trim()) values.push(lines[next].trim())
    }
    return values.join('\n').trim()
  }
  return ''
}

function hasSectionHeader(task, names) {
  return String(task).split(/\r?\n/).some((line) => {
    const match = line.match(/^\s*#*\s*([^:\n]+):/)
    return match && names.includes(match[1].trim().toLowerCase())
  })
}

function referencedLedgerIds(value) {
  const source = String(value).toUpperCase()
  const ids = []
  const ranges = /\b([A-Z]*)(\d+)\s*-\s*([A-Z]*)(\d+)\b/g
  for (const match of source.matchAll(ranges)) {
    const leftPrefix = match[1]
    const rightPrefix = match[3] || leftPrefix
    const start = Number(match[2])
    const end = Number(match[4])
    if (leftPrefix !== rightPrefix || end < start || end - start > 100) {
      throw new Error(`Invalid ledger item range: ${match[0]}`)
    }
    for (let current = start; current <= end; current += 1) {
      ids.push(`${leftPrefix}${current}`)
    }
  }
  const withoutRanges = source.replace(ranges, ' ')
  ids.push(...(withoutRanges.match(/\b(?:[A-Z]+\d+|V|\d+)\b/g) || []))
  return [...new Set(ids)]
}

export function validateTaskContract({ task, ledger = null }) {
  const normalizedTask = String(task || '')
  const headingNames = [
    'ledger items', 'objective', 'inputs', 'allowed files', 'allowed files/systems',
    'allowed scope', 'acceptance checks', 'return exactly',
  ]
  const detailed = normalizedTask.length > DETAILED_TASK_THRESHOLD
    || hasSectionHeader(normalizedTask, headingNames)
  if (!detailed) return { detailed: false, ledgerIds: [] }
  if (normalizedTask.length > DETAILED_TASK_THRESHOLD && !ledger) {
    throw new Error(`Detailed task files above ${DETAILED_TASK_THRESHOLD} characters require a ledger`)
  }

  const required = [
    ['ledger items'],
    ['objective'],
    ['inputs'],
    ['allowed files', 'allowed files/systems', 'allowed scope'],
    ['acceptance checks'],
  ]
  for (const names of required) {
    if (!sectionValue(normalizedTask, names)) {
      throw new Error(`Detailed task contract is missing ${names[0]}`)
    }
  }
  const returnContract = sectionValue(normalizedTask, ['return exactly'])
  if (!returnContract || !HANDOFF_FIELDS.every((field) => returnContract.includes(field))) {
    throw new Error('Detailed task contract must require the exact five-field return')
  }
  const ids = referencedLedgerIds(sectionValue(normalizedTask, ['ledger items']))
  if (ids.length === 0) throw new Error('Detailed task contract must cite ledger item IDs')
  if (ledger) {
    const knownIds = ledgerItemIds(ledger.content)
    const missing = ids.filter((id) => !knownIds.has(id))
    if (missing.length) {
      throw new Error(`Task cites ledger IDs that do not exist: ${missing.join(', ')}`)
    }
  }
  return { detailed: true, ledgerIds: ids }
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

async function writeWorkerRecord(dataDir, runId, workerId, record) {
  await writeJsonAtomic(path.join(workerDir(dataDir, runId, workerId), 'worker.json'), record)
}

export async function materializeWorker({
  runId,
  workerId,
  role: roleName,
  taskFile,
  owns,
  allowWrite = false,
  dataDir = defaultDataDir(),
}) {
  const run = await loadRun({ runId, dataDir })
  const normalizedWorkerId = assertIdentifier(workerId, 'worker id')
  const targetWorkerDir = workerDir(dataDir, runId, normalizedWorkerId)
  if (await optionalStat(targetWorkerDir)) {
    throw new Error(`Worker already exists: ${normalizedWorkerId}`)
  }
  const role = resolveManagedAgentRole(roleName)
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
  if (normalizedOwns.length) await assertOwnsPathsSafe(run.cwd, normalizedOwns)
  const activeWorkers = (await listWorkerRecords({ runId, dataDir }))
    .filter((worker) => !TERMINAL_STATES.has(worker.status))
  if (activeWorkers.length >= MAX_CONCURRENCY) {
    throw new Error(`Run already has ${MAX_CONCURRENCY} active workers`)
  }
  if (role.sandbox === 'workspace-write') assertWriteOwnershipAvailable(activeWorkers, normalizedOwns)
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
      schemaVersion: 1,
      runId,
      workerId: normalizedWorkerId,
      role: roleName,
      model: role.model,
      effort: role.effort,
      serviceTier: 'fast',
      sandbox: role.sandbox,
      lane: role.lane,
      owns: normalizedOwns,
      ledgerPath: ledger?.path ?? null,
      ledgerIds: taskContract.ledgerIds,
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
    ? `Private handoff paths: the controller grants ${record.scratchPath} as an additional writable directory for bulky evidence and captures your final five-field response at ${record.reportPath}. Never write outside the assigned repository ownership and that scratch directory.`
    : `Private handoff path: keep the repository read-only. The controller captures your final five-field response at ${record.reportPath}; use that durable report for evidence and do not attempt to write ${record.scratchPath}.`
  return [
    'You are a bounded worker launched by the GPT-5.6 Orchestrator controller.',
    'The main interactive session owns planning, task assignment, every consequential decision, and final acceptance; it must disclose if the required GPT-5.6 Sol max chair cannot be verified.',
    `Run objective: ${run.objective}`,
    `Worker role: ${record.role}`,
    `Pinned runtime: ${role.model}, reasoning effort ${role.effort}, service tier fast, sandbox ${role.sandbox}.`,
    `Role contract: ${role.instructions}`,
    handoff,
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
  const role = resolveManagedAgentRole(record.role)
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
  record = {
    ...record,
    status: 'running',
    backend: WORKER_BACKEND,
    startedAt,
    updatedAt: startedAt,
    pid: process.pid,
  }
  await writeWorkerRecord(dataDir, runId, workerId, record)
  const eventsPath = path.join(targetWorkerDir, 'events.jsonl')
  const stderrPath = path.join(targetWorkerDir, 'stderr.log')
  const outputPath = record.reportPath
  if (await optionalStat(outputPath)) {
    throw new Error(`Worker report path must not already exist: ${outputPath}`)
  }
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
  try {
    eventsHandle = await openPrivateOutput(eventsPath)
    stderrHandle = await openPrivateOutput(stderrPath)
    const workerEnv = {
      ...env,
      GPT56_ORCHESTRATOR_DISABLE: '1',
    }
    const recursionGuard = {
      multiAgentDisabled: args.includes('features.multi_agent=false'),
      orchestratorHooksDisabled: workerEnv.GPT56_ORCHESTRATOR_DISABLE === '1',
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
    const success = outcome.code === 0
      && outcome.signal === null
      && runtime.threadId
      && runtime.completed
      && recursionGuard.multiAgentDisabled
      && recursionGuard.orchestratorHooksDisabled
      && resultInfo?.isFile()
      && resultInfo.size > 0
    const completedAt = new Date().toISOString()
    const proof = {
      schemaVersion: 2,
      status: success ? 'completed' : 'failed',
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
      startedAt,
      completedAt,
      taskPath: record.taskPath,
      scratchPath: record.scratchPath,
      reportPath: outputPath,
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
      reportPath: outputPath,
      scratchPath: record.scratchPath,
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
  owns,
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
    owns,
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
    backend: WORKER_BACKEND,
    processId: child.pid,
    proofRequired: path.join(workerDir(dataDir, runId, workerId), 'proof.json'),
    scratchPath: record.scratchPath,
    reportPath: record.reportPath,
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

export function renderDashboard(status) {
  const counts = Object.entries(status.counts || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([state, count]) => `${state}: ${count}`)
    .join(', ') || 'none'
  const rows = status.workers.length === 0
    ? ['(no workers)']
    : status.workers.map((worker) => {
      const owns = worker.owns?.length ? worker.owns.join(',') : '-'
      const handoff = worker.reportPath ? path.basename(worker.reportPath) : '-'
      return `${worker.workerId}\t${worker.status}\t${worker.role}\t${owns}\t${handoff}`
    })
  return [
    `Run: ${status.runId}`,
    `Objective: ${status.objective}`,
    `Controller: ${status.controller.model} ${status.controller.effort} (${status.controller.authority})`,
    `Worker backend: ${status.workerBackend}`,
    `Complete: ${status.complete ? 'yes' : 'no'}; successful: ${status.successful ? 'yes' : 'no'}; counts: ${counts}`,
    '',
    'Worker\tStatus\tRole\tOwns\tReport',
    ...rows,
  ].join('\n')
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
  intervalMs = 1000,
  dataDir = defaultDataDir(),
  write = (value) => process.stdout.write(value),
}) {
  const normalizedInterval = normalizeIntervalMs(intervalMs)
  do {
    const status = await getRunStatus({ runId, dataDir })
    if (watch) write('\x1Bc')
    write(`${renderDashboard(status)}\n`)
    if (!watch) return status
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

export async function openTmuxPane({
  runId,
  width = 40,
  intervalMs = 1000,
  env = process.env,
}) {
  const normalizedRunId = assertIdentifier(runId, 'run id')
  if (!env.TMUX) throw new Error('pane requires an existing tmux client; run it from inside tmux')
  const normalizedWidth = normalizePaneWidth(width)
  const normalizedInterval = normalizeIntervalMs(intervalMs)
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
    dataDir: env.GPT56_ORCHESTRATOR_DATA_DIR || null,
  })
  const created = await runChild(tmuxBin, [
    'split-window', '-h', '-d', '-p', String(normalizedWidth),
    '-P', '-F', '#{pane_id}', command,
  ], { env })
  if (created.code !== 0) throw new Error(`Unable to open tmux dashboard pane: ${created.stderr.trim() || 'tmux split failed'}`)
  const paneId = created.stdout.trim() || null
  if (paneId) {
    await runChild(tmuxBin, ['select-pane', '-t', paneId, '-T', 'GPT-5.6 agents'], { env })
      .catch(() => {})
  }
  return { runId: normalizedRunId, paneId, width: normalizedWidth, intervalMs: normalizedInterval, command }
}

function parseArguments(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    if (['allow-write', 'json', 'watch'].includes(key)) {
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
    '  create --cwd <dir> --objective <text> [--run-id <id>]',
    '  spawn --run <id> --worker <id> --role <role> --task-file <path> [--allow-write --owns <path[,path]>]',
    '  status --run <id> [--json]',
    '  dashboard --run <id> [--watch] [--interval-ms <n>]',
    '  pane --run <id> [--width <percent>] [--interval-ms <n>]',
    '  wait --run <id> [--worker <id>] [--timeout-seconds <n>] [--json]',
    '  stop --run <id> [--worker <id>]',
    '  roles',
    '',
    `Roles: ${MANAGED_AGENT_TYPES.join(', ')}`,
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
      dataDir,
    })
  } else if (command === 'status') {
    result = await getRunStatus({ runId: options.run, dataDir })
  } else if (command === 'dashboard') {
    await runDashboard({
      runId: options.run,
      watch: options.watch === true,
      intervalMs: options['interval-ms'] || 1000,
      dataDir,
    })
    return
  } else if (command === 'pane') {
    result = await openTmuxPane({
      runId: options.run,
      width: options.width || 40,
      intervalMs: options['interval-ms'] || 1000,
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

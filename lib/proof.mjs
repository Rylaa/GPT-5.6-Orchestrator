import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { resolveManagedAgentRole } from './routing.mjs'
import { HANDOFF_FIELDS, validateHandoffReport } from './task-contract.mjs'

const MAX_JSON_BYTES = 1024 * 1024
const MAX_REPORT_BYTES = 1024 * 1024
const SAFE_IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const CONTROLLER_MODEL = 'gpt-5.6-sol'
const CONTROLLER_EFFORT = 'max'
const CONTROLLER_AUTHORITY = 'main-session'
const CONTROLLER_ATTESTATION = 'declared-main-session-contract'
const WORKER_BACKEND = 'codex-exec-background'

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function readBoundedJson(targetPath) {
  const info = await lstat(targetPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) {
    throw new Error(`Expected a bounded regular JSON file: ${targetPath}`)
  }
  return JSON.parse(await readFile(targetPath, 'utf8'))
}

export async function assertContainedPath(rootPath, targetPath, { type = null } = {}) {
  const resolvedRoot = path.resolve(rootPath)
  const resolvedTarget = path.resolve(targetPath)
  if (!isInside(resolvedRoot, resolvedTarget)) {
    throw new Error(`JSON path escapes its trusted root: ${resolvedTarget}`)
  }

  const rootInfo = await lstat(resolvedRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Trusted JSON root is not a regular directory: ${resolvedRoot}`)
  }
  const relative = path.relative(resolvedRoot, resolvedTarget)
  let current = resolvedRoot
  let targetInfo = rootInfo
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    targetInfo = await lstat(current)
    if (targetInfo.isSymbolicLink()) {
      throw new Error(`JSON path contains a symlinked component: ${current}`)
    }
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    realpath(resolvedRoot),
    realpath(resolvedTarget),
  ])
  if (!isInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`JSON path resolves outside its trusted root: ${resolvedTarget}`)
  }
  if (type === 'directory' && !targetInfo.isDirectory()) {
    throw new Error(`Trusted path is not a directory: ${resolvedTarget}`)
  }
  if (type === 'file' && !targetInfo.isFile()) {
    throw new Error(`Trusted path is not a regular file: ${resolvedTarget}`)
  }
  return { resolvedRoot, resolvedTarget, canonicalRoot, canonicalTarget }
}

export async function readContainedBoundedJson(rootPath, targetPath) {
  const { resolvedTarget } = await assertContainedPath(rootPath, targetPath, { type: 'file' })
  return readBoundedJson(resolvedTarget)
}

function hasValidEvidenceWindow(proof) {
  const startedAt = Date.parse(proof?.startedAt)
  const completedAt = Date.parse(proof?.completedAt)
  return Number.isFinite(startedAt)
    && Number.isFinite(completedAt)
    && completedAt >= startedAt
}

export async function validateWorkerProofPath({
  proofPath,
  cwd,
  dataDir,
  expectedRunId = null,
}) {
  try {
    const resolvedProofPath = path.resolve(proofPath)
    const runsRoot = path.join(path.resolve(dataDir), 'runs')
    if (!isInside(runsRoot, resolvedProofPath)) {
      return { valid: false, reason: 'proof is outside the runs directory' }
    }
    const proof = await readContainedBoundedJson(runsRoot, resolvedProofPath)
    if (
      ![2, 3].includes(proof.schemaVersion)
      || !SAFE_IDENTIFIER.test(String(proof.runId || ''))
      || !SAFE_IDENTIFIER.test(String(proof.workerId || ''))
      || (expectedRunId && proof.runId !== expectedRunId)
    ) return { valid: false, reason: 'proof has an invalid or mismatched identity' }
    const role = resolveManagedAgentRole(proof.role)
    if (!role) return { valid: false, reason: 'proof has an unmanaged role' }
    const expectedProofPath = path.join(
      runsRoot,
      String(proof.runId || ''),
      'workers',
      String(proof.workerId || ''),
      'proof.json',
    )
    if (resolvedProofPath !== expectedProofPath) {
      return { valid: false, reason: 'proof path does not match its identity' }
    }
    const workerRoot = path.dirname(expectedProofPath)
    const expectedArtifacts = {
      taskPath: path.join(workerRoot, 'task.md'),
      scratchPath: path.join(workerRoot, 'scratch'),
      reportPath: path.join(workerRoot, 'report.md'),
      resultPath: path.join(workerRoot, 'report.md'),
      eventsPath: path.join(workerRoot, 'events.jsonl'),
      stderrPath: path.join(workerRoot, 'stderr.log'),
    }
    if (Object.entries(expectedArtifacts).some(([key, expected]) => proof[key] !== expected)) {
      return { valid: false, reason: 'proof handoff paths do not match its identity' }
    }
    if (
      proof.status !== 'completed'
      || proof.backend !== WORKER_BACKEND
      || proof.model !== role.model
      || proof.effort !== role.effort
      || proof.sandbox !== role.sandbox
      || proof.serviceTier !== 'fast'
      || typeof proof.threadId !== 'string'
      || proof.threadId.length === 0
      || proof.runtimeCompleted !== true
      || proof.recursionGuard?.multiAgentDisabled !== true
      || (proof.schemaVersion === 3 && proof.recursionGuard?.pluginsDisabled !== true)
      || proof.recursionGuard?.orchestratorHooksDisabled !== true
      || proof.exitCode !== 0
      || !hasValidEvidenceWindow(proof)
    ) return { valid: false, reason: 'proof runtime contract is incomplete' }
    if (proof.schemaVersion === 3) {
      if (
        proof.launchContract?.source !== 'controller-cli-request'
        || proof.launchContract?.model !== role.model
        || proof.launchContract?.effort !== role.effort
        || proof.launchContract?.serviceTier !== 'fast'
        || proof.launchContract?.sandbox !== role.sandbox
        || proof.runtimeEvidence?.source !== 'codex-json-events'
        || proof.runtimeEvidence?.lifecycleValid !== true
        || proof.runtimeEvidence?.threadStartCount !== 1
        || proof.runtimeEvidence?.completionCount !== 1
        || proof.runtimeEvidence?.malformedLines !== 0
        || proof.runtimeEvidence?.modelObserved !== false
        || proof.runtimeEvidence?.effortObserved !== false
        || proof.reportContract?.valid !== true
        || !HANDOFF_FIELDS.every((field) => proof.reportContract.fields?.includes(field))
        || proof.ownership?.valid !== true
      ) return { valid: false, reason: 'proof v3 evidence contract is incomplete' }

      const worker = await readContainedBoundedJson(
        runsRoot,
        path.join(workerRoot, 'worker.json'),
      )
      if (
        worker.runId !== proof.runId
        || worker.workerId !== proof.workerId
        || worker.role !== proof.role
        || worker.model !== proof.model
        || worker.effort !== proof.effort
        || worker.sandbox !== proof.sandbox
        || worker.status !== 'completed'
        || worker.proofPath !== expectedProofPath
        || worker.threadId !== proof.threadId
      ) return { valid: false, reason: 'proof does not match its completed worker record' }

      await assertContainedPath(runsRoot, proof.reportPath, { type: 'file' })
      const reportInfo = await lstat(proof.reportPath)
      if (
        !reportInfo.isFile()
        || reportInfo.isSymbolicLink()
        || reportInfo.size === 0
        || reportInfo.size > MAX_REPORT_BYTES
      ) return { valid: false, reason: 'proof report is not a bounded regular file' }
      const report = await readFile(proof.reportPath, 'utf8')
      const reportContract = validateHandoffReport(report)
      const digest = createHash('sha256').update(report).digest('hex')
      if (
        !reportContract.valid
        || proof.reportContract.size !== reportInfo.size
        || proof.reportContract.sha256 !== digest
      ) return { valid: false, reason: 'proof report contract or digest does not match' }

      const expectedBaseline = role.sandbox === 'workspace-write'
        ? path.join(workerRoot, 'workspace-baseline.json')
        : null
      if (proof.baselinePath !== expectedBaseline) {
        return { valid: false, reason: 'proof ownership baseline path does not match its identity' }
      }
    }
    const run = await readContainedBoundedJson(
      runsRoot,
      path.join(runsRoot, proof.runId, 'run.json'),
    )
    const runCwd = await realpath(run.cwd).catch(() => path.resolve(run.cwd || ''))
    const resolvedCwd = await realpath(cwd).catch(() => path.resolve(cwd))
    if (
      run.runId !== proof.runId
      || runCwd !== resolvedCwd
      || run.controller?.model !== CONTROLLER_MODEL
      || run.controller?.effort !== CONTROLLER_EFFORT
      || run.controller?.authority !== CONTROLLER_AUTHORITY
      || (proof.schemaVersion === 3 && run.controller?.attestation !== CONTROLLER_ATTESTATION)
      || run.workerBackend !== WORKER_BACKEND
    ) return { valid: false, reason: 'proof belongs to another workspace or controller' }
    return { valid: true, proof, role: proof.role }
  } catch (error) {
    return { valid: false, reason: `proof could not be validated: ${error?.message || 'unknown error'}` }
  }
}

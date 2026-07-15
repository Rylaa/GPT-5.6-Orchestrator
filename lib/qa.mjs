import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'

import {
  findLedger,
  parseLedger,
  readLedger,
} from './ledger.mjs'
import { resolveManagedAgentRole } from './routing.mjs'

const execFileAsync = promisify(execFile)
const MAX_JSON_BYTES = 1024 * 1024
const FALLBACK_MAX_FILES = 20_000
const FALLBACK_MAX_BYTES = 512 * 1024 * 1024
const FALLBACK_EXCLUDED_DIRS = new Set(['.git', '.workflow', 'node_modules'])
const SAFE_IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const TERMINAL_WORKER_STATES = new Set(['completed', 'failed', 'stopped'])

export const QA_TIERS = Object.freeze({
  q0: Object.freeze({ label: 'Q0 Inline', testsRequired: false, reviewRoles: [] }),
  q1: Object.freeze({
    label: 'Q1 Standard',
    testsRequired: true,
    reviewRoles: ['orchestrator_luna_reviewer'],
  }),
  q2: Object.freeze({
    label: 'Q2 Deep',
    testsRequired: true,
    reviewRoles: ['orchestrator_terra_reviewer'],
  }),
  q3: Object.freeze({
    label: 'Q3 Critical',
    testsRequired: true,
    reviewRoles: ['orchestrator_terra_reviewer', 'orchestrator_sol_verifier'],
  }),
})

export function normalizeQaTier(value, fallback = null) {
  const normalized = String(value || fallback || '').trim().toLowerCase()
  if (!QA_TIERS[normalized]) throw new Error('QA tier must be one of q0, q1, q2, or q3')
  return normalized
}

export function claimsTaskCompletion(message) {
  const text = String(message || '')
  if (!text.trim()) return false
  const negative = /(?:not|isn['’]t|wasn['’]t|hasn['’]t|henüz|daha)\s+(?:fully\s+)?(?:complete[dl]?|done|finished|ready|updated|shipped|tamam(?:landı)?|bit(?:ti|medi)|hazır|güncellendi)|(?:incomplete|not\s+ready|tamamlanmad[ıi]|bitmedi|hazır\s+değil|güncellenmedi)|(?:still|hala)\s+(?:working|reviewing|testing|çalışıyorum|inceliyorum|test\s+ediyorum)/iu
  if (negative.test(text)) return false
  return /(?:^|\n)\s*(?:done|completed|finished|implemented|fixed|updated|added|shipped|ready|tamamlandı|bitti|hazır|uygulandı|düzeltildi|güncellendi|eklendi)\b|(?:work|task|implementation|change|plugin|feature|fix|iş|görev|uygulama|değişiklik|düzeltme)[^\n]{0,80}(?:complete[dl]?|done|finished|updated|shipped|ready|tamamlandı|bitti|hazır|güncellendi)|\b(?:tamamladım|bitirdim|uyguladım|düzelttim|güncelledim|ekledim|değiştirdim)\b|\.workflow\/closure\.json/iu.test(text)
}

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

async function gitWorkspaceDigest(cwd) {
  let root
  try {
    const result = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      maxBuffer: MAX_JSON_BYTES,
    })
    root = await realpath(result.stdout.trim())
  } catch {
    return null
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'g56o-index-'))
  const indexPath = path.join(temporaryDirectory, 'index')
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_OPTIONAL_LOCKS: '0',
  }
  const git = async (args) => execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 8 * MAX_JSON_BYTES,
  })

  try {
    try {
      await git(['read-tree', 'HEAD'])
    } catch {
      await git(['read-tree', '--empty'])
    }
    await git(['rm', '-r', '--cached', '--ignore-unmatch', '--', '.workflow'])
    await git([
      'add', '-A', '--', '.',
      ':(exclude).workflow',
      ':(exclude).workflow/**',
    ])
    const result = await git(['write-tree'])
    return `git-tree:${result.stdout.trim()}`
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function fallbackWorkspaceDigest(cwd) {
  const root = await realpath(path.resolve(cwd))
  const hash = createHash('sha256')
  let fileCount = 0
  let byteCount = 0

  async function walk(directory, relativeDirectory = '') {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isDirectory() && FALLBACK_EXCLUDED_DIRS.has(entry.name)) continue
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      fileCount += 1
      if (fileCount > FALLBACK_MAX_FILES) throw new Error('Non-git workspace has too many files to hash safely')
      hash.update(`${entry.isSymbolicLink() ? 'L' : 'F'}\0${relativePath}\0`)
      if (entry.isSymbolicLink()) {
        hash.update(await readlink(absolutePath))
        continue
      }
      const info = await lstat(absolutePath)
      if (!info.isFile()) continue
      byteCount += info.size
      if (byteCount > FALLBACK_MAX_BYTES) throw new Error('Non-git workspace is too large to hash safely')
      for await (const chunk of createReadStream(absolutePath)) hash.update(chunk)
    }
  }

  await walk(root)
  return `files:${hash.digest('hex')}`
}

export async function workspaceDigest(cwd) {
  return await gitWorkspaceDigest(cwd) || fallbackWorkspaceDigest(cwd)
}

export function isQaReviewRole(roleName) {
  return roleName === 'orchestrator_luna_reviewer'
    || roleName === 'orchestrator_terra_reviewer'
    || roleName === 'orchestrator_sol_verifier'
}

async function readRunWorkerRecords(runsRoot, runId) {
  const workersRoot = path.join(runsRoot, runId, 'workers')
  await assertContainedPath(runsRoot, workersRoot, { type: 'directory' })
  const entries = await readdir(workersRoot, { withFileTypes: true })
  const records = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Worker directory must not be a symlink: ${entry.name}`)
    }
    if (!entry.isDirectory() || !SAFE_IDENTIFIER.test(entry.name)) continue
    const record = await readContainedBoundedJson(
      runsRoot,
      path.join(workersRoot, entry.name, 'worker.json'),
    )
    if (record.runId !== runId || record.workerId !== entry.name) {
      throw new Error(`Worker record identity mismatch: ${entry.name}`)
    }
    records.push(record)
  }
  return records
}

export async function validateWorkerProofPath({
  proofPath,
  cwd,
  dataDir,
  expectedDigest = null,
  requireStable = false,
  expectedRunId = null,
}) {
  try {
    const resolvedProofPath = path.resolve(proofPath)
    const runsRoot = path.join(path.resolve(dataDir), 'runs')
    if (!isInside(runsRoot, resolvedProofPath)) return { valid: false, reason: 'proof is outside the runs directory' }
    const proof = await readContainedBoundedJson(runsRoot, resolvedProofPath)
    if (
      !SAFE_IDENTIFIER.test(String(proof.runId || ''))
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
    if (resolvedProofPath !== expectedProofPath) return { valid: false, reason: 'proof path does not match its identity' }
    if (
      proof.status !== 'completed'
      || proof.model !== role.model
      || proof.effort !== role.effort
      || proof.sandbox !== role.sandbox
      || proof.serviceTier !== 'fast'
      || typeof proof.threadId !== 'string'
      || proof.threadId.length === 0
      || proof.runtimeCompleted !== true
      || proof.exitCode !== 0
      || !hasValidEvidenceWindow(proof)
    ) return { valid: false, reason: 'proof runtime contract is incomplete' }
    const run = await readContainedBoundedJson(
      runsRoot,
      path.join(runsRoot, proof.runId, 'run.json'),
    )
    const runCwd = await realpath(run.cwd).catch(() => path.resolve(run.cwd || ''))
    const resolvedCwd = await realpath(cwd).catch(() => path.resolve(cwd))
    if (
      run.runId !== proof.runId
      || runCwd !== resolvedCwd
      || run.controller?.model !== 'gpt-5.6-sol'
    ) {
      return { valid: false, reason: 'proof belongs to another workspace or controller' }
    }
    if (expectedDigest && proof.workspaceDigest !== expectedDigest) {
      return { valid: false, reason: 'proof is stale for the current workspace' }
    }
    if (requireStable && proof.workspaceDigestStarted !== proof.workspaceDigest) {
      return { valid: false, reason: 'workspace changed while QA review was running' }
    }
    return { valid: true, proof, role: proof.role }
  } catch (error) {
    return { valid: false, reason: `proof could not be validated: ${error?.message || 'unknown error'}` }
  }
}

export async function validateTestProofPath({
  proofPath,
  cwd,
  dataDir,
  expectedDigest,
  expectedRunId = null,
}) {
  try {
    const resolvedProofPath = path.resolve(proofPath)
    const runsRoot = path.join(path.resolve(dataDir), 'runs')
    if (!isInside(runsRoot, resolvedProofPath)) return { valid: false, reason: 'test proof is outside the runs directory' }
    const proof = await readContainedBoundedJson(runsRoot, resolvedProofPath)
    if (
      !SAFE_IDENTIFIER.test(String(proof.runId || ''))
      || !SAFE_IDENTIFIER.test(String(proof.testId || ''))
      || (expectedRunId && proof.runId !== expectedRunId)
    ) return { valid: false, reason: 'test proof has an invalid or mismatched identity' }
    const expectedProofPath = path.join(
      runsRoot,
      String(proof.runId || ''),
      'tests',
      String(proof.testId || ''),
      'proof.json',
    )
    if (resolvedProofPath !== expectedProofPath) return { valid: false, reason: 'test proof path does not match its identity' }
    if (
      proof.status !== 'passed'
      || proof.exitCode !== 0
      || !Array.isArray(proof.command)
      || proof.command.length === 0
      || proof.workspaceDigestStarted !== expectedDigest
      || proof.workspaceDigest !== expectedDigest
      || !hasValidEvidenceWindow(proof)
    ) return { valid: false, reason: 'test proof failed or is stale' }
    const run = await readContainedBoundedJson(
      runsRoot,
      path.join(runsRoot, proof.runId, 'run.json'),
    )
    const runCwd = await realpath(run.cwd).catch(() => path.resolve(run.cwd || ''))
    const resolvedCwd = await realpath(cwd).catch(() => path.resolve(cwd))
    if (
      run.runId !== proof.runId
      || runCwd !== resolvedCwd
      || run.controller?.model !== 'gpt-5.6-sol'
    ) {
      return { valid: false, reason: 'test proof belongs to another workspace or controller' }
    }
    return { valid: true, proof }
  } catch (error) {
    return { valid: false, reason: `test proof could not be validated: ${error?.message || 'unknown error'}` }
  }
}

export async function validateClosure({ cwd, dataDir }) {
  try {
    const ledgerPath = await findLedger(cwd)
    if (!ledgerPath) return { valid: false, reason: 'No workflow ledger exists.' }
    const ledger = parseLedger(await readLedger(ledgerPath))
    if (ledger.totalItems === 0) return { valid: false, reason: 'The workflow ledger has no acceptance items.' }
    if (ledger.openItems.length > 0) {
      return { valid: false, reason: `The workflow ledger still has ${ledger.openItems.length} open item(s).` }
    }
    const tier = normalizeQaTier(ledger.qaTier)
    const closurePath = path.join(path.dirname(ledgerPath), 'closure.json')
    const closure = await readBoundedJson(closurePath)
    if (
      closure.schemaVersion !== 1
      || closure.status !== 'accepted'
      || closure.solVerdict !== 'accepted'
      || closure.qaTier !== tier
    ) return { valid: false, reason: 'The closure does not contain an accepted Sol verdict for the ledger QA tier.' }
    const currentDigest = await workspaceDigest(cwd)
    if (closure.workspaceDigest !== currentDigest) {
      return { valid: false, reason: 'The closure is stale because the workspace changed after QA.' }
    }
    if (
      closure.ledger?.totalItems !== ledger.totalItems
      || closure.ledger?.closedItems !== ledger.closedItems
    ) return { valid: false, reason: 'The closure ledger counts are stale.' }

    const runsRoot = path.join(path.resolve(dataDir), 'runs')
    if (!SAFE_IDENTIFIER.test(String(closure.runId || ''))) {
      return { valid: false, reason: 'The closure has an invalid run identity.' }
    }
    const run = await readContainedBoundedJson(
      runsRoot,
      path.join(runsRoot, String(closure.runId || ''), 'run.json'),
    )
    const runCwd = await realpath(run.cwd).catch(() => path.resolve(run.cwd || ''))
    const resolvedCwd = await realpath(cwd).catch(() => path.resolve(cwd))
    if (
      run.runId !== closure.runId
      || runCwd !== resolvedCwd
      || run.qaTier !== tier
      || run.controller?.model !== 'gpt-5.6-sol'
    ) {
      return { valid: false, reason: 'The closure run does not match this workspace or QA tier.' }
    }
    const receipt = await readContainedBoundedJson(
      runsRoot,
      path.join(runsRoot, closure.runId, 'closure-receipt.json'),
    )
    if (!isDeepStrictEqual(receipt, closure)) {
      return { valid: false, reason: 'The workspace closure does not match its private controller receipt.' }
    }

    const testProofs = []
    for (const proofPath of Array.isArray(closure.tests) ? closure.tests : []) {
      const result = await validateTestProofPath({
        proofPath,
        cwd,
        dataDir,
        expectedDigest: currentDigest,
        expectedRunId: closure.runId,
      })
      if (!result.valid) return { valid: false, reason: result.reason }
      testProofs.push(result.proof)
    }
    const tierPolicy = QA_TIERS[tier]
    if (tierPolicy.testsRequired && testProofs.length === 0) {
      return { valid: false, reason: `${tier.toUpperCase()} requires current passing test evidence.` }
    }
    const workerRecords = await readRunWorkerRecords(runsRoot, closure.runId)
    if (workerRecords.some((worker) => !TERMINAL_WORKER_STATES.has(worker.status))) {
      return { valid: false, reason: 'The closure run still contains an active worker.' }
    }
    const writerCompletionTimes = workerRecords
      .filter((worker) => worker.sandbox === 'workspace-write')
      .map((worker) => Date.parse(worker.completedAt))
    if (writerCompletionTimes.some((timestamp) => !Number.isFinite(timestamp))) {
      return { valid: false, reason: 'A write worker has an invalid completion timestamp.' }
    }
    const latestWriterAt = Math.max(0, ...writerCompletionTimes)
    if (testProofs.some((proof) => (Date.parse(proof.startedAt) || 0) <= latestWriterAt)) {
      return { valid: false, reason: 'Direct tests did not start strictly after write workers finished.' }
    }

    const reviewProofs = []
    for (const proofPath of Array.isArray(closure.reviews) ? closure.reviews : []) {
      const result = await validateWorkerProofPath({
        proofPath,
        cwd,
        dataDir,
        expectedDigest: currentDigest,
        requireStable: true,
        expectedRunId: closure.runId,
      })
      if (!result.valid) return { valid: false, reason: result.reason }
      reviewProofs.push(result.proof)
    }
    const reviewByRole = new Map(reviewProofs.map((proof) => [proof.role, proof]))
    for (const role of tierPolicy.reviewRoles) {
      if (!reviewByRole.has(role)) return { valid: false, reason: `${tier.toUpperCase()} requires ${role}.` }
    }
    const latestTestAt = Math.max(0, ...testProofs.map((proof) => Date.parse(proof.completedAt) || 0))
    for (const role of tierPolicy.reviewRoles) {
      const review = reviewByRole.get(role)
      if ((Date.parse(review.startedAt) || 0) <= latestTestAt) {
        return { valid: false, reason: `${role} did not start strictly after direct tests finished.` }
      }
    }
    if (tier === 'q3') {
      const terraCompletedAt = Date.parse(reviewByRole.get('orchestrator_terra_reviewer').completedAt) || 0
      const solStartedAt = Date.parse(reviewByRole.get('orchestrator_sol_verifier').startedAt) || 0
      if (solStartedAt <= terraCompletedAt) {
        return { valid: false, reason: 'Q3 Sol verification did not start strictly after Terra review finished.' }
      }
    }
    return { valid: true, closure, closurePath, ledger, currentDigest }
  } catch (error) {
    return { valid: false, reason: error?.message || 'QA closure validation failed.' }
  }
}

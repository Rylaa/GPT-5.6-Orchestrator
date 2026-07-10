import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const METRICS_MAX_BYTES = 5 * 1024 * 1024
const SESSION_STATE_MAX_BYTES = 1024 * 1024
const METRIC_KEYS = new Set([
  'event',
  'profile',
  'model',
  'reason',
  'toolName',
  'agentType',
  'turnId',
  'promptLength',
  'threshold',
  'outcome',
])

export function hashSessionId(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex')
}

export function getSessionStatePath(dataDir, sessionId) {
  return path.join(path.resolve(dataDir), 'sessions', `${hashSessionId(sessionId)}.json`)
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe symlinked plugin data directory: ${directory}`)
  }
  await chmod(directory, 0o700)
}

export async function readSessionState(dataDir, sessionId) {
  const resolvedDataDir = path.resolve(dataDir)
  await ensurePrivateDirectory(resolvedDataDir)
  const sessionsDir = path.join(resolvedDataDir, 'sessions')
  await ensurePrivateDirectory(sessionsDir)
  const statePath = getSessionStatePath(resolvedDataDir, sessionId)
  const noFollow = constants.O_NOFOLLOW ?? 0
  let handle
  try {
    const entry = await lstat(statePath)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Session state must be a regular file, not a symlink: ${statePath}`)
    }
    handle = await open(statePath, constants.O_RDONLY | noFollow)
    const info = await handle.stat()
    if (!info.isFile() || info.size > SESSION_STATE_MAX_BYTES) {
      throw new Error(`Session state is not a bounded regular file: ${statePath}`)
    }
    const parsed = JSON.parse(await handle.readFile('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  } finally {
    if (handle) await handle.close()
  }
}

export async function writeSessionState(dataDir, sessionId, state) {
  const resolvedDataDir = path.resolve(dataDir)
  await ensurePrivateDirectory(resolvedDataDir)
  const statePath = getSessionStatePath(resolvedDataDir, sessionId)
  const directory = path.dirname(statePath)
  await ensurePrivateDirectory(directory)
  const tempPath = path.join(directory, `.${path.basename(statePath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, statePath)
  } finally {
    await unlink(tempPath).catch(() => {})
  }
  return statePath
}

function sanitizeMetric(metric) {
  const sanitized = { timestamp: new Date().toISOString() }
  for (const [key, value] of Object.entries(metric || {})) {
    if (!METRIC_KEYS.has(key)) continue
    if (['string', 'number', 'boolean'].includes(typeof value)) sanitized[key] = value
  }
  return sanitized
}

async function rotateMetricsIfNeeded(metricsPath) {
  try {
    const info = await lstat(metricsPath)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Metrics path must be a regular file, not a symlink: ${metricsPath}`)
    }
    if (info.size < METRICS_MAX_BYTES) return
    await rename(metricsPath, `${metricsPath}.1`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function appendMetric(dataDir, metric) {
  const resolvedDataDir = path.resolve(dataDir)
  await ensurePrivateDirectory(resolvedDataDir)
  const metricsPath = path.join(resolvedDataDir, 'metrics.jsonl')
  await rotateMetricsIfNeeded(metricsPath)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(
    metricsPath,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow,
    0o600,
  )
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`Metrics path must be a regular file: ${metricsPath}`)
    await handle.chmod(0o600)
    await handle.writeFile(`${JSON.stringify(sanitizeMetric(metric))}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

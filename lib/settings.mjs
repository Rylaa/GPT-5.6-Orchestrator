import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_SOL_EFFORT = 'high'
export const SUPPORTED_SOL_EFFORTS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const SETTINGS_SCHEMA_VERSION = 1
const MAX_SETTINGS_BYTES = 64 * 1024

async function optionalStat(targetPath) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function ensurePrivateDataDir(dataDir) {
  const resolved = path.resolve(dataDir)
  const info = await optionalStat(resolved)
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`Unsafe Orchestrator data directory: ${resolved}`)
  }
  if (!info) await mkdir(resolved, { recursive: true, mode: 0o700 })
  await chmod(resolved, 0o700)
  return resolved
}

export function normalizeSolEffort(value, fallback = DEFAULT_SOL_EFFORT) {
  const candidate = String(value ?? fallback).trim().toLowerCase()
  if (!SUPPORTED_SOL_EFFORTS.includes(candidate)) {
    throw new RangeError(
      `Unsupported Sol reasoning effort ${value}; choose one of: ${SUPPORTED_SOL_EFFORTS.join(', ')}`,
    )
  }
  return candidate
}

export async function readOrchestratorSettings(dataDir, { env = process.env } = {}) {
  const environmentValue = String(env.GPT56_ORCHESTRATOR_SOL_EFFORT || '').trim()
  if (environmentValue) {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      solEffort: normalizeSolEffort(environmentValue),
      source: 'environment',
    }
  }

  const resolvedDataDir = path.resolve(dataDir)
  const dataInfo = await optionalStat(resolvedDataDir)
  if (!dataInfo) {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      solEffort: DEFAULT_SOL_EFFORT,
      source: 'default',
    }
  }
  if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) {
    throw new Error(`Unsafe Orchestrator data directory: ${resolvedDataDir}`)
  }

  const settingsPath = path.join(resolvedDataDir, 'settings.json')
  const info = await optionalStat(settingsPath)
  if (!info) {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      solEffort: DEFAULT_SOL_EFFORT,
      source: 'default',
    }
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SETTINGS_BYTES) {
    throw new Error(`Expected a bounded regular settings file: ${settingsPath}`)
  }
  const payload = JSON.parse(await readFile(settingsPath, 'utf8'))
  if (payload?.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new Error(`Unsupported Orchestrator settings schema: ${payload?.schemaVersion}`)
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    solEffort: normalizeSolEffort(payload.solEffort),
    source: 'settings',
  }
}

export async function writeOrchestratorSettings(dataDir, { solEffort }) {
  const resolvedDataDir = await ensurePrivateDataDir(dataDir)
  const settingsPath = path.join(resolvedDataDir, 'settings.json')
  const existing = await optionalStat(settingsPath)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Unsafe Orchestrator settings path: ${settingsPath}`)
  }
  const payload = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    solEffort: normalizeSolEffort(solEffort),
  }
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporaryPath, settingsPath)
    await chmod(settingsPath, 0o600)
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
  return { ...payload, source: 'settings', settingsPath }
}

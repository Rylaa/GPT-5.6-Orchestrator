#!/usr/bin/env node

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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const AGENT_PROFILE_FILES = Object.freeze([
  'csf-luna-gatherer.toml',
  'csf-luna-worker.toml',
  'csf-luna-reviewer.toml',
  'csf-sol-verifier.toml',
])

const MANAGED_MARKER = '# Managed by codex-sol-fusion.'

async function optionalStat(targetPath) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function resolveAgentDirectory(codexHome, { create = false } = {}) {
  const agentsDir = path.resolve(codexHome, 'agents')
  let info = await optionalStat(agentsDir)
  if (!info && !create) return null
  if (!info) {
    await mkdir(agentsDir, { recursive: true, mode: 0o700 })
    info = await lstat(agentsDir)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe Codex agents directory: ${agentsDir}`)
  }
  if (create) await chmod(agentsDir, 0o700)
  return agentsDir
}

function profilePaths({ codexHome, pluginRoot, filename }) {
  return {
    sourcePath: path.resolve(pluginRoot, 'agents', filename),
    targetPath: path.resolve(codexHome, 'agents', filename),
  }
}

async function readManagedSource(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  if (!source.startsWith(`${MANAGED_MARKER}\n`)) {
    throw new Error(`Agent profile is missing its managed marker: ${sourcePath}`)
  }
  return source
}

async function writeAtomic(targetPath, content) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, targetPath)
    await chmod(targetPath, 0o600)
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

export async function installAgentProfiles({ codexHome, pluginRoot }) {
  const agentsDir = await resolveAgentDirectory(codexHome, { create: true })
  const outcome = { installed: [], updated: [], unchanged: [] }

  for (const filename of AGENT_PROFILE_FILES) {
    const { sourcePath, targetPath } = profilePaths({ codexHome, pluginRoot, filename })
    const source = await readManagedSource(sourcePath)
    const targetInfo = await optionalStat(targetPath)

    if (targetInfo?.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite a symlinked agent profile: ${targetPath}`)
    }
    if (targetInfo && !targetInfo.isFile()) {
      throw new Error(`Refusing to overwrite a non-file agent profile: ${targetPath}`)
    }
    if (!targetInfo) {
      await writeAtomic(targetPath, source)
      outcome.installed.push(filename)
      continue
    }

    const current = await readFile(targetPath, 'utf8')
    if (current === source) {
      await chmod(targetPath, 0o600)
      outcome.unchanged.push(filename)
      continue
    }
    if (!current.startsWith(`${MANAGED_MARKER}\n`)) {
      throw new Error(`Refusing to overwrite an unmanaged agent profile: ${targetPath}`)
    }
    await writeAtomic(targetPath, source)
    outcome.updated.push(filename)
  }

  await chmod(agentsDir, 0o700)
  return outcome
}

export async function checkAgentProfiles({ codexHome, pluginRoot }) {
  const missing = []
  const changed = []
  const agentsDir = await resolveAgentDirectory(codexHome)

  for (const filename of AGENT_PROFILE_FILES) {
    const { sourcePath, targetPath } = profilePaths({ codexHome, pluginRoot, filename })
    const source = await readManagedSource(sourcePath)
    if (!agentsDir) {
      missing.push(filename)
      continue
    }
    const targetInfo = await optionalStat(targetPath)
    if (!targetInfo) {
      missing.push(filename)
      continue
    }
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      changed.push(filename)
      continue
    }
    if (await readFile(targetPath, 'utf8') !== source) changed.push(filename)
  }

  return { ok: missing.length === 0 && changed.length === 0, missing, changed }
}

export async function removeAgentProfiles({ codexHome }) {
  const agentsDir = await resolveAgentDirectory(codexHome)
  const removed = []
  const skipped = []
  if (!agentsDir) return { removed, skipped }

  for (const filename of AGENT_PROFILE_FILES) {
    const targetPath = path.join(agentsDir, filename)
    const targetInfo = await optionalStat(targetPath)
    if (!targetInfo) continue
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      skipped.push(filename)
      continue
    }
    const current = await readFile(targetPath, 'utf8')
    if (!current.startsWith(`${MANAGED_MARKER}\n`)) {
      skipped.push(filename)
      continue
    }
    await unlink(targetPath)
    removed.push(filename)
  }

  return { removed, skipped }
}

function parseCliArguments(argv) {
  const [action = 'check', ...rest] = argv
  const homeIndex = rest.indexOf('--codex-home')
  const codexHome = homeIndex >= 0 ? rest[homeIndex + 1] : process.env.CODEX_HOME
  if (homeIndex >= 0 && !codexHome) throw new Error('--codex-home requires a path')
  return { action, codexHome: path.resolve(codexHome || path.join(os.homedir(), '.codex')) }
}

async function main() {
  const { action, codexHome } = parseCliArguments(process.argv.slice(2))
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let result
  if (action === 'install') result = await installAgentProfiles({ codexHome, pluginRoot })
  else if (action === 'check') result = await checkAgentProfiles({ codexHome, pluginRoot })
  else if (action === 'remove') result = await removeAgentProfiles({ codexHome })
  else throw new Error(`Unknown action: ${action}. Use install, check, or remove.`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`codex-sol-fusion: ${error.message}\n`)
    process.exitCode = 1
  })
}

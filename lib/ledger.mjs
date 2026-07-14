import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const MAX_LEDGER_BYTES = 256 * 1024
export const LEDGER_RELATIVE_PATH = path.join('.workflow', 'LEDGER.md')

async function safeLstat(targetPath) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

async function findSearchBoundary(cwd) {
  const resolvedCwd = await realpath(path.resolve(cwd))
  let current = resolvedCwd
  while (true) {
    if (await safeLstat(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  const home = await realpath(path.resolve(os.homedir()))
  const relativeToHome = path.relative(home, resolvedCwd)
  const insideHome = relativeToHome === ''
    || (!relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome))
  return insideHome ? home : resolvedCwd
}

function isContainedBy(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function findLedger(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  let current
  let boundary
  try {
    current = await realpath(path.resolve(cwd))
    boundary = await findSearchBoundary(current)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }

  while (true) {
    const workflowPath = path.join(current, '.workflow')
    const workflowInfo = await safeLstat(workflowPath)
    if (workflowInfo?.isDirectory() && !workflowInfo.isSymbolicLink()) {
      const candidate = path.join(workflowPath, 'LEDGER.md')
      const info = await safeLstat(candidate)
      if (info?.isFile() && !info.isSymbolicLink()) {
        const resolvedCandidate = await realpath(candidate)
        if (isContainedBy(boundary, resolvedCandidate)) return resolvedCandidate
      }
    }
    if (current === boundary) return null
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function readLedger(ledgerPath) {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(ledgerPath, constants.O_RDONLY | noFollow)
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new Error('Ledger must be a regular file, not a symlink')
    }
    if (info.size > MAX_LEDGER_BYTES) {
      throw new Error(`Ledger is too large (max ${MAX_LEDGER_BYTES} bytes)`)
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

export function parseLedger(content) {
  const openItems = []
  let totalItems = 0
  let closedItems = 0

  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+\[([ xX~])\]\s*(.*?)\s*$/)
    if (!match) continue
    totalItems += 1
    const status = match[1].toLowerCase()
    const label = match[2] || '(unnamed requirement)'
    const isDeferred = status === '~' && /^deferred\s*:/i.test(label)
    if (status === 'x' || isDeferred) closedItems += 1
    else openItems.push(label)
  }

  return { totalItems, closedItems, openItems }
}

export function patchTouchesOnlyLedger(patchText) {
  if (typeof patchText !== 'string') return false
  const targets = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm)]
    .map((match) => match[1].replaceAll('\\', '/'))
  if (targets.length === 0) return false
  return targets.every((target) => (
    target === '.workflow/LEDGER.md'
    || target.endsWith('/.workflow/LEDGER.md')
  ))
}

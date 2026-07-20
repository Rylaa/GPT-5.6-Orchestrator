import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_TRACKED_PATHS = 100_000

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function gitOutput(cwd, args, encoding = 'utf8') {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

async function hashRegularFile(targetPath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(targetPath)) hash.update(chunk)
  return `file:${hash.digest('hex')}`
}

async function pathFingerprint(targetPath) {
  try {
    const info = await lstat(targetPath)
    if (info.isSymbolicLink()) return `symlink:${await readlink(targetPath)}`
    if (info.isFile()) return hashRegularFile(targetPath)
    if (info.isDirectory()) return 'directory'
    return `other:${info.mode}:${info.size}`
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

export async function captureWorkspaceSnapshot({ cwd, extraPaths = [] }) {
  const { inputCwd, cwd: resolvedCwd, gitRoot } = await resolveGitWorkspace(cwd)
  const gitPathspec = path.relative(gitRoot, resolvedCwd).replaceAll(path.sep, '/') || '.'
  const raw = await gitOutput(
    gitRoot,
    ['ls-files', '--full-name', '-z', '--cached', '--others', '--exclude-standard', '--', gitPathspec],
    'buffer',
  )
  const paths = new Set()
  for (const item of raw.toString('utf8').split('\0').filter(Boolean)) {
    const absolute = path.resolve(gitRoot, item)
    if (inside(resolvedCwd, absolute)) paths.add(path.relative(resolvedCwd, absolute).replaceAll(path.sep, '/'))
  }
  for (const extraPath of extraPaths) {
    if (!extraPath) continue
    const inputAbsolute = path.resolve(extraPath)
    const absolute = inside(inputCwd, inputAbsolute)
      ? path.resolve(resolvedCwd, path.relative(inputCwd, inputAbsolute))
      : inputAbsolute
    if (inside(resolvedCwd, absolute)) paths.add(path.relative(resolvedCwd, absolute).replaceAll(path.sep, '/'))
  }
  if (paths.size > MAX_TRACKED_PATHS) {
    throw new Error(`Workspace snapshot exceeds ${MAX_TRACKED_PATHS} paths`)
  }
  const entries = {}
  for (const relative of [...paths].sort()) {
    entries[relative] = await pathFingerprint(path.join(resolvedCwd, ...relative.split('/')))
  }
  return { schemaVersion: 1, cwd: resolvedCwd, gitRoot, entries }
}

export async function resolveGitWorkspace(cwd) {
  const inputCwd = path.resolve(cwd)
  const resolvedCwd = await realpath(inputCwd)
  let gitRoot
  try {
    gitRoot = await realpath(
      path.resolve(String(await gitOutput(resolvedCwd, ['rev-parse', '--show-toplevel'])).trim()),
    )
  } catch {
    throw new Error('Write workers require a Git worktree for ownership verification')
  }
  if (!inside(gitRoot, resolvedCwd)) throw new Error('Worker cwd is outside its Git worktree')
  return { inputCwd, cwd: resolvedCwd, gitRoot }
}

export function changedSnapshotPaths(before, after) {
  if (before.cwd !== after.cwd || before.gitRoot !== after.gitRoot) {
    throw new Error('Workspace snapshots belong to different roots')
  }
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])
  return [...paths].filter((item) => before.entries[item] !== after.entries[item]).sort()
}

export function pathIsOwned(relativePath, owns) {
  return owns.some((owned) => relativePath === owned || relativePath.startsWith(`${owned}/`))
}

export function validateSnapshotOwnership({ before, after, owns }) {
  const changedPaths = changedSnapshotPaths(before, after)
  const outsidePaths = changedPaths.filter((item) => !pathIsOwned(item, owns))
  return { valid: outsidePaths.length === 0, changedPaths, outsidePaths }
}

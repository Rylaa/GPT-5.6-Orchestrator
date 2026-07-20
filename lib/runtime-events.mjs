import { open, lstat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'

export const MAX_EVENT_BYTES = 64 * 1024 * 1024
const MAX_ACTIVITY_TAIL_BYTES = 256 * 1024
const DEFAULT_ACTIVITY_ITEMS = 6
const MAX_ACTIVITY_TEXT_CHARS = 220
const CONTROL_AND_ANSI_RE = /(?:\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x1f\x7f-\x9f])/g
const FILE_TOKEN_RE = /[a-z0-9_@.+-]+(?:\/[a-z0-9_@.+-]+)*\.(?:swift|mjs|cjs|js|jsx|ts|tsx|json|toml|md|py|rb|go|rs|java|kt|kts|c|cc|cpp|h|hpp|sh|bash|zsh|ya?ml|sql|graphql|css|scss|html|xml|gradle|lock|pbxproj)/gi
const SECRET_PATTERNS = Object.freeze([
  /\b(authorization|api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_)[a-z0-9_-]{8,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi,
])

export function sanitizeActivityText(value, maxChars = MAX_ACTIVITY_TEXT_CHARS) {
  let normalized = String(value || '')
    .replace(CONTROL_AND_ANSI_RE, ' ')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
  for (const pattern of SECRET_PATTERNS) {
    normalized = normalized.replace(pattern, (match, label) => (
      typeof label === 'string' && label ? `${label}=[redacted]` : '[redacted credential]'
    ))
  }
  normalized = normalized.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 1).trimEnd()}…`
    : normalized
}

function safeIdentifier(value) {
  const normalized = String(value || '').trim()
  return /^[a-z0-9_.:-]{1,64}$/i.test(normalized) ? normalized : null
}

function safeFileLabels(command, limit = 3) {
  const matches = String(command || '').match(FILE_TOKEN_RE) || []
  const labels = []
  for (const match of matches) {
    const segments = match.split('/').filter((segment) => segment && segment !== '.' && segment !== '..')
    const label = sanitizeActivityText(segments.slice(-2).join('/'), 96)
    if (label && !labels.includes(label)) labels.push(label)
  }
  const shown = labels.slice(0, limit)
  if (labels.length > limit) shown.push(`+${labels.length - limit} files`)
  return shown
}

function commandDescription(command) {
  const source = String(command || '')
  const lower = source.toLowerCase()
  const files = safeFileLabels(source)
  const withFiles = (value) => files.length ? `${value} — ${files.join(', ')}` : value

  if (
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|typecheck)\b/.test(lower)
    || /\b(?:node\s+--test|pytest|cargo\s+test|go\s+test|swift\s+test|gradlew?\b[^\n]*\btest|xcodebuild\b[^\n]*\btest)\b/.test(lower)
  ) {
    return { kind: 'test', running: 'Running project checks', completed: 'Project checks finished', review: 'Reviewing test results' }
  }
  if (/\b(?:apply_patch|patch)\b|\bsed\s+-i\b/.test(lower)) {
    return { kind: 'edit', running: withFiles('Updating files'), completed: withFiles('Updated files'), review: 'Reviewing the latest file changes' }
  }
  if (
    /\bgit\b[^\n]*(?:\bstatus\b|\bdiff\b|\blog\b|\bshow\b|\bblame\b|\bls-files\b)/.test(lower)
    && !/\b(?:rg|grep|ag)\b/.test(lower)
  ) {
    return { kind: 'git', running: withFiles('Inspecting Git history and changes'), completed: withFiles('Inspected Git history and changes'), review: 'Reviewing repository evidence' }
  }
  if (/\b(?:rg|grep|ag)\b/.test(lower)) {
    const listing = /\b(?:rg|grep)\b[^\n]*--files\b/.test(lower)
    return listing
      ? { kind: 'search', running: 'Mapping project files', completed: 'Mapped project files', review: 'Reviewing the project file map' }
      : { kind: 'search', running: withFiles('Searching source code'), completed: withFiles('Searched source code'), review: 'Reviewing source-search results' }
  }
  if (/\b(?:sed|cat|head|tail|nl|less)\b/.test(lower)) {
    return { kind: 'read', running: withFiles('Reading source files'), completed: withFiles('Read source files'), review: 'Analyzing the files just inspected' }
  }
  if (/\b(?:find|fd)\b|\bls\b/.test(lower)) {
    return { kind: 'files', running: 'Inspecting the project structure', completed: 'Inspected the project structure', review: 'Reviewing the project structure' }
  }
  if (/\b(?:xcodebuild|swift\s+build|cargo\s+build|go\s+build|npm\s+run\s+build|pnpm\s+(?:run\s+)?build)\b/.test(lower)) {
    return { kind: 'build', running: 'Building the project', completed: 'Project build finished', review: 'Reviewing build results' }
  }
  if (/\b(?:curl|wget|gh\s+(?:api|search|repo))\b/.test(lower)) {
    return { kind: 'network', running: 'Fetching external technical evidence', completed: 'Fetched external technical evidence', review: 'Reviewing external evidence' }
  }
  if (/\b(?:jq|plutil)\b/.test(lower)) {
    return { kind: 'inspect', running: withFiles('Inspecting structured data'), completed: withFiles('Inspected structured data'), review: 'Reviewing structured data' }
  }
  return { kind: 'command', running: withFiles('Running a project command'), completed: withFiles('Project command finished'), review: 'Reviewing the latest command results' }
}

function itemActivity(event) {
  const item = event?.item || {}
  const itemType = String(item.type || '')
  const started = event?.type === 'item.started'
  const expectedEmptySearch = !started
    && item.exit_code === 1
    && /\b(?:rg|grep|ag)\b/.test(String(item.command || '').toLowerCase())
  const expectedGitDifference = !started
    && item.exit_code === 1
    && /\bgit\b[^\n]*\bdiff\b[^\n]*(?:--quiet|--exit-code)/.test(String(item.command || '').toLowerCase())
  const failed = !started && item.status === 'failed' && !expectedEmptySearch && !expectedGitDifference
  const state = started ? 'running' : failed ? 'failed' : 'completed'
  const key = typeof item.id === 'string' ? `${itemType}:${item.id}` : null

  if (itemType === 'agent_message') {
    const text = sanitizeActivityText(item.text)
    return {
      key,
      kind: 'agent-update',
      state: 'info',
      summary: text ? `Agent update: ${text}` : 'Agent shared a progress update',
      current: text || 'Reviewing the assigned task',
    }
  }
  if (itemType === 'command_execution') {
    const description = commandDescription(item.command)
    const emptySuffix = expectedEmptySearch ? ' (no matching result)' : ''
    return {
      key,
      kind: description.kind,
      state,
      summary: failed ? `${description.completed} (failed)` : started ? description.running : `${description.completed}${emptySuffix}`,
      current: failed ? 'Investigating a command failure' : started ? description.running : description.review,
    }
  }
  if (itemType === 'file_change') {
    const files = safeFileLabels(JSON.stringify(item.changes || item.files || ''))
    const suffix = files.length ? ` — ${files.join(', ')}` : ''
    return {
      key,
      kind: 'edit',
      state,
      summary: `${started ? 'Updating files' : failed ? 'File update failed' : 'Updated files'}${suffix}`,
      current: started ? `Updating files${suffix}` : failed ? 'Investigating a file update failure' : 'Reviewing the latest file changes',
    }
  }
  if (itemType === 'mcp_tool_call') {
    const tool = safeIdentifier(item.tool || item.name || item.server)
    const suffix = tool ? ` — ${tool}` : ''
    return {
      key,
      kind: 'tool',
      state,
      summary: `${started ? 'Using a connected tool' : failed ? 'Connected tool failed' : 'Connected tool finished'}${suffix}`,
      current: started ? `Using a connected tool${suffix}` : failed ? 'Investigating a connected-tool failure' : 'Reviewing connected-tool results',
    }
  }
  if (itemType === 'web_search') {
    return {
      key,
      kind: 'web-search',
      state,
      summary: started ? 'Searching technical sources' : failed ? 'Technical-source search failed' : 'Searched technical sources',
      current: started ? 'Searching technical sources' : failed ? 'Investigating a search failure' : 'Reviewing technical-source results',
    }
  }
  if (itemType === 'todo_list') {
    const count = Array.isArray(item.items) ? item.items.length : null
    const suffix = count ? ` (${count} steps)` : ''
    return {
      key,
      kind: 'plan',
      state,
      summary: `${started ? 'Updating the work plan' : 'Work plan updated'}${suffix}`,
      current: 'Choosing the next task step',
    }
  }
  if (itemType === 'reasoning') {
    return {
      key,
      kind: 'analysis',
      state,
      summary: started ? 'Analyzing evidence' : 'Evidence analysis updated',
      current: 'Analyzing evidence and deciding the next step',
    }
  }
  return {
    key,
    kind: 'activity',
    state,
    summary: started ? 'Working on the assigned task' : failed ? 'A task step failed' : 'Completed a task step',
    current: failed ? 'Investigating a failed task step' : 'Continuing the assigned task',
  }
}

function eventActivity(event) {
  if (event?.type === 'thread.started') {
    return { key: 'thread', kind: 'lifecycle', state: 'completed', summary: 'Worker session started', current: 'Starting the assigned task' }
  }
  if (event?.type === 'turn.started') {
    return { key: 'turn', kind: 'lifecycle', state: 'running', summary: 'Assigned task started', current: 'Reading the task and planning the investigation' }
  }
  if (event?.type === 'turn.completed') {
    return { key: 'turn', kind: 'lifecycle', state: 'completed', summary: 'Worker turn completed', current: 'Finalizing the handoff report' }
  }
  if (event?.type === 'turn.failed') {
    return { key: 'turn', kind: 'lifecycle', state: 'failed', summary: 'Worker turn failed', current: 'Task execution failed' }
  }
  if (event?.type === 'item.started' || event?.type === 'item.completed') return itemActivity(event)
  return null
}

function eventSummary(event) {
  return eventActivity(event)?.summary || null
}

function consumeEvent(result, event) {
  result.eventCount += 1
  const summary = eventSummary(event)
  if (summary) result.lastActivity = summary
  if (event?.type === 'thread.started' && typeof event.thread_id === 'string') {
    result.threadStartCount += 1
    result.threadIds.add(event.thread_id)
    result.threadId = result.threadId || event.thread_id
  }
  if (event?.type === 'turn.completed') {
    if (!result.threadId) result.completionBeforeThread = true
    result.completionCount += 1
    result.completed = true
    result.usage = event.usage ?? result.usage
  }
}

export async function parseRuntimeProofFile(eventsPath, { maxBytes = MAX_EVENT_BYTES } = {}) {
  const info = await lstat(eventsPath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Worker events must be a regular non-symlink file: ${eventsPath}`)
  }
  if (info.size > maxBytes) throw new Error(`Worker events exceed ${maxBytes} bytes`)
  const result = {
    threadId: null,
    threadIds: new Set(),
    threadStartCount: 0,
    completed: false,
    completionCount: 0,
    completionBeforeThread: false,
    usage: null,
    eventCount: 0,
    malformedLines: 0,
    lastActivity: null,
    bytes: info.size,
  }
  const input = createReadStream(eventsPath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      consumeEvent(result, JSON.parse(line))
    } catch {
      result.malformedLines += 1
    }
  }
  result.validLifecycle = result.threadIds.size === 1
    && result.threadStartCount === 1
    && result.completionCount === 1
    && !result.completionBeforeThread
    && result.malformedLines === 0
  result.threadIds = [...result.threadIds]
  return result
}

export async function readLatestActivity(eventsPath, {
  maxBytes = MAX_ACTIVITY_TAIL_BYTES,
  maxItems = DEFAULT_ACTIVITY_ITEMS,
} = {}) {
  try {
    const info = await lstat(eventsPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) return null
    const length = Math.min(info.size, maxBytes)
    const position = info.size - length
    const handle = await open(eventsPath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      await handle.read(buffer, 0, length, position)
      let text = buffer.toString('utf8')
      if (position > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1))
      const activities = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const activity = eventActivity(JSON.parse(line))
          if (!activity) continue
          if (activity.key) {
            const priorIndex = activities.findIndex((candidate) => candidate.key === activity.key)
            if (priorIndex !== -1) activities.splice(priorIndex, 1)
          }
          const prior = activities.at(-1)
          if (!prior || prior.summary !== activity.summary || prior.state !== activity.state) {
            activities.push(activity)
          }
          if (activities.length > Math.max(16, maxItems * 4)) activities.shift()
        } catch {
          // A bounded tail may begin inside one large JSON event.
        }
      }
      const latest = activities.at(-1)
      if (!latest) return null
      const meaningful = activities.filter((activity) => activity.kind !== 'lifecycle')
      const recentSource = meaningful.length ? meaningful : activities
      const recent = recentSource.slice(-Math.max(1, Math.min(12, Number(maxItems) || DEFAULT_ACTIVITY_ITEMS)))
        .map(({ key: _key, current: _current, ...activity }) => activity)
      return {
        summary: latest.current || latest.summary,
        kind: latest.kind,
        state: latest.state,
        recent,
        updatedAt: info.mtime.toISOString(),
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

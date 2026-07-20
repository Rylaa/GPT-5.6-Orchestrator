import { open, lstat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'

export const MAX_EVENT_BYTES = 64 * 1024 * 1024
const MAX_ACTIVITY_TAIL_BYTES = 256 * 1024
const ITEM_ACTIVITY_LABELS = Object.freeze({
  agent_message: 'agent message',
  command_execution: 'command',
  file_change: 'file change',
  mcp_tool_call: 'tool call',
  reasoning: 'reasoning',
  todo_list: 'todo list',
  web_search: 'web search',
})

function itemActivityLabel(item) {
  return ITEM_ACTIVITY_LABELS[String(item?.type || '')] || 'item'
}

function eventSummary(event) {
  if (event?.type === 'thread.started') return 'thread started'
  if (event?.type === 'turn.started') return 'turn started'
  if (event?.type === 'turn.completed') return 'turn completed'
  if (event?.type === 'turn.failed') return 'turn failed'
  if (event?.type === 'item.started') {
    return `${itemActivityLabel(event.item)} running`
  }
  if (event?.type === 'item.completed') {
    return `${itemActivityLabel(event.item)} completed`
  }
  return null
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

export async function readLatestActivity(eventsPath, { maxBytes = MAX_ACTIVITY_TAIL_BYTES } = {}) {
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
      let summary = null
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          summary = eventSummary(JSON.parse(line)) || summary
        } catch {
          // A bounded tail may begin inside one large JSON event.
        }
      }
      return summary ? { summary, updatedAt: info.mtime.toISOString() } : null
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

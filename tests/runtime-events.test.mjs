import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parseRuntimeProofFile, readLatestActivity } from '../lib/runtime-events.mjs'

async function eventFile(lines) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-events-'))
  const target = path.join(root, 'events.jsonl')
  await writeFile(target, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return target
}

test('accepts one coherent thread lifecycle and exposes only bounded activity metadata', async () => {
  const target = await eventFile([
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'command_execution', command: 'secret command' } },
    { type: 'turn.completed', usage: { input_tokens: 10 } },
  ])
  const parsed = await parseRuntimeProofFile(target)
  assert.equal(parsed.validLifecycle, true)
  assert.equal(parsed.threadId, 'thread-1')
  assert.equal(parsed.completionCount, 1)
  const activity = await readLatestActivity(target)
  assert.equal(activity.summary, 'turn completed')
  assert.doesNotMatch(activity.summary, /secret command/)
})

test('rejects multiple threads, completion-before-thread, and oversized logs', async () => {
  const multiple = await eventFile([
    { type: 'thread.started', thread_id: 'one' },
    { type: 'thread.started', thread_id: 'two' },
    { type: 'turn.completed' },
  ])
  assert.equal((await parseRuntimeProofFile(multiple)).validLifecycle, false)
  const reversed = await eventFile([
    { type: 'turn.completed' },
    { type: 'thread.started', thread_id: 'one' },
  ])
  assert.equal((await parseRuntimeProofFile(reversed)).validLifecycle, false)
  const duplicate = await eventFile([
    { type: 'thread.started', thread_id: 'one' },
    { type: 'thread.started', thread_id: 'one' },
    { type: 'turn.completed' },
  ])
  assert.equal((await parseRuntimeProofFile(duplicate)).validLifecycle, false)
  await assert.rejects(() => parseRuntimeProofFile(reversed, { maxBytes: 1 }), /exceed/i)
})

test('counts malformed diagnostics without accepting a weak lifecycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-events-'))
  const target = path.join(root, 'events.jsonl')
  await writeFile(target, '{bad}\n' + JSON.stringify({ type: 'thread.started', thread_id: 'one' }) + '\n')
  const parsed = await parseRuntimeProofFile(target)
  assert.equal(parsed.malformedLines, 1)
  assert.equal(parsed.validLifecycle, false)
})

test('fails closed on malformed lines and never echoes unknown item types', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-events-'))
  const target = path.join(root, 'events.jsonl')
  await writeFile(target, [
    JSON.stringify({ type: 'thread.started', thread_id: 'one' }),
    '{bad}',
    JSON.stringify({ type: 'item.completed', item: { type: 'secret prompt text' } }),
    JSON.stringify({ type: 'turn.completed' }),
    '',
  ].join('\n'))
  const parsed = await parseRuntimeProofFile(target)
  assert.equal(parsed.threadStartCount, 1)
  assert.equal(parsed.completionCount, 1)
  assert.equal(parsed.validLifecycle, false)
  const activity = await readLatestActivity(target)
  assert.equal(activity.summary, 'turn completed')

  const itemOnly = await eventFile([
    { type: 'item.completed', item: { type: 'secret prompt text' } },
  ])
  assert.equal((await readLatestActivity(itemOnly)).summary, 'item completed')
})

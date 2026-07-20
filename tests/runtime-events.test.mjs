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
  assert.equal(activity.summary, 'Finalizing the handoff report')
  assert.deepEqual(activity.recent, [{
    kind: 'command',
    state: 'running',
    summary: 'Running a project command',
  }])
  assert.doesNotMatch(activity.summary, /secret command/)
  assert.doesNotMatch(JSON.stringify(activity), /secret command/)
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
  assert.equal(activity.summary, 'Finalizing the handoff report')

  const itemOnly = await eventFile([
    { type: 'item.completed', item: { type: 'secret prompt text' } },
  ])
  assert.equal((await readLatestActivity(itemOnly)).summary, 'Continuing the assigned task')
})

test('renders safe human activity without exposing raw commands, output, or credentials', async () => {
  const target = await eventFile([
    { type: 'thread.started', thread_id: 'thread-safe' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'search-1',
        type: 'command_execution',
        command: "rg -n 'api_key=super-secret-value' src/CommentIntelligenceScreen.swift src/sk-proj-abcdefghijklmnopqrstuvwxyz.json",
        aggregated_output: 'password=hunter2',
        exit_code: 0,
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'message-1',
        type: 'agent_message',
        text: 'I traced the navigation path. token=ghp_abcdefghijklmnopqrstuvwxyz123456',
      },
    },
  ])
  const activity = await readLatestActivity(target)
  assert.equal(activity.summary, 'I traced the navigation path. token=[redacted]')
  assert.deepEqual(activity.recent.map(({ kind, state }) => ({ kind, state })), [
    { kind: 'search', state: 'completed' },
    { kind: 'agent-update', state: 'info' },
  ])
  assert.match(activity.recent[0].summary, /Searched source code.*CommentIntelligenceScreen\.swift/)
  assert.doesNotMatch(JSON.stringify(activity), /super-secret|hunter2|ghp_|sk-proj-/)
})

test('distinguishes common work categories and treats empty searches as useful evidence', async () => {
  const target = await eventFile([
    {
      type: 'item.completed',
      item: {
        id: 'read-1', type: 'command_execution', command: 'sed -n 1,80p src/App.swift',
        status: 'completed', exit_code: 0,
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'search-1', type: 'command_execution', command: "rg -n 'MissingSymbol' src/App.swift",
        status: 'failed', exit_code: 1,
      },
    },
    {
      type: 'item.started',
      item: { id: 'test-1', type: 'command_execution', command: 'npm test', status: 'in_progress' },
    },
  ])
  const activity = await readLatestActivity(target)
  assert.equal(activity.summary, 'Running project checks')
  assert.deepEqual(activity.recent.map(({ kind, state }) => ({ kind, state })), [
    { kind: 'read', state: 'completed' },
    { kind: 'search', state: 'completed' },
    { kind: 'test', state: 'running' },
  ])
  assert.match(activity.recent[1].summary, /no matching result/i)
})

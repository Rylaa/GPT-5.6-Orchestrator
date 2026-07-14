import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const pluginRoot = path.resolve(import.meta.dirname, '..')
const hookPath = path.join(pluginRoot, 'hooks', 'orchestrator-hook.mjs')

function runHook(action, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, action], {
      cwd: env.cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('hook CLI consumes Codex JSON and emits schema-valid JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-cli-'))
  const result = await runHook('user-prompt-submit', JSON.stringify({
    session_id: 'session-e2e',
    cwd: root,
    model: 'gpt-5.6-sol',
    hook_event_name: 'UserPromptSubmit',
    turn_id: 'turn-e2e',
    prompt: 'review this task',
  }), {
    cwd: root,
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: path.join(root, 'data'),
  })

  assert.equal(result.code, 0)
  const output = JSON.parse(result.stdout)
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(output.hookSpecificOutput.additionalContext, /Sol at max/i)
  assert.match(output.hookSpecificOutput.additionalContext, /Decompose every request/i)
})

test('hook CLI fails open on malformed or oversized input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'g56o-cli-'))
  const env = {
    cwd: root,
    PLUGIN_ROOT: pluginRoot,
    PLUGIN_DATA: path.join(root, 'data'),
  }
  const malformed = await runHook('user-prompt-submit', '{not-json', env)
  assert.equal(malformed.code, 0)
  assert.equal(malformed.stdout, '')

  const oversized = await runHook('user-prompt-submit', 'x'.repeat(1_100_000), env)
  assert.equal(oversized.code, 0)
  assert.equal(oversized.stdout, '')
})

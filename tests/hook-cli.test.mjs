import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const pluginRoot = path.resolve(import.meta.dirname, '..')
const hookPath = path.join(pluginRoot, 'hooks', 'orchestrator-hook.mjs')
const pluginName = 'gpt-5-6-orchestrator'

const hookActions = {
  SessionStart: 'session-start',
  PostCompact: 'post-compact',
  UserPromptSubmit: 'user-prompt-submit',
  PreToolUse: 'pre-tool-use',
  SubagentStart: 'subagent-start',
  SubagentStop: 'subagent-stop',
  Stop: 'stop',
}

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
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') reject(error)
    })
    child.stdin.end(input)
  })
}

function runHookCommand(command, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
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
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') reject(error)
    })
    child.stdin.end(input)
  })
}

async function hookCommands() {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'))
  return Object.fromEntries(Object.entries(manifest.hooks).map(([event, groups]) => [
    event,
    groups[0].hooks[0].command,
  ]))
}

async function createInstalledHook(family, version, {
  manifestName = pluginName,
  manifestVersion = version,
  output = 'resolved',
  symlinkTarget,
} = {}) {
  const root = path.join(family, version)
  await mkdir(path.join(root, '.codex-plugin'), { recursive: true })
  await mkdir(path.join(root, 'hooks'), { recursive: true })
  await writeFile(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: manifestName,
    version: manifestVersion,
  }))
  const installedHook = path.join(root, 'hooks', 'orchestrator-hook.mjs')
  if (symlinkTarget) await symlink(symlinkTarget, installedHook)
  else await writeFile(installedHook, `process.stdout.write(${JSON.stringify(output)} + ':' + process.argv[2])\n`)
  return root
}

async function createHookFamily(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'g56o-launcher-'))
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }))
  const family = path.join(temporaryRoot, 'cache with spaces', pluginName)
  await mkdir(family, { recursive: true })
  return { temporaryRoot, family }
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
  assert.match(output.hookSpecificOutput.additionalContext, /Sol at the configured high reasoning target/i)
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

test('hook launcher uses the supplied current root and preserves the action', async (t) => {
  const { temporaryRoot, family } = await createHookFamily(t)
  const current = await createInstalledHook(family, '0.3.3+codex.20260721010101', {
    output: 'current',
  })
  const commands = await hookCommands()
  const result = await runHookCommand(commands.UserPromptSubmit, '', {
    cwd: temporaryRoot,
    PLUGIN_ROOT: current,
  })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'current:user-prompt-submit')
  assert.equal(result.stderr, '')
})

test('every hook launcher recovers a pruned session root and preserves its event action', async (t) => {
  const { temporaryRoot, family } = await createHookFamily(t)
  await createInstalledHook(family, '0.3.3+codex.20260721010202', { output: 'fallback' })
  const staleRoot = path.join(family, '0.3.2+codex.20260721000000')
  const commands = await hookCommands()

  for (const [event, action] of Object.entries(hookActions)) {
    const result = await runHookCommand(commands[event], '', {
      cwd: temporaryRoot,
      PLUGIN_ROOT: staleRoot,
    })
    assert.equal(result.code, 0, event)
    assert.equal(result.stdout, `fallback:${action}`, event)
    assert.equal(result.stderr, '', event)
  }
})

test('hook launcher rejects malformed and symlink sibling candidates', async (t) => {
  const { temporaryRoot, family } = await createHookFamily(t)
  const valid = await createInstalledHook(family, '0.3.3+codex.20260721010303', {
    output: 'valid',
  })
  const wrongName = await createInstalledHook(family, '9.0.0+codex.20260721010404', {
    manifestName: 'untrusted-plugin',
    output: 'wrong-name',
  })
  const wrongVersion = await createInstalledHook(family, '9.0.0+codex.20260721010505', {
    manifestVersion: '9.0.1+codex.20260721010505',
    output: 'wrong-version',
  })
  const externalHook = path.join(temporaryRoot, 'external-hook.mjs')
  await writeFile(externalHook, "process.stdout.write('symlink:' + process.argv[2])\n")
  const linkedHook = await createInstalledHook(family, '9.0.0+codex.20260721010606', {
    symlinkTarget: externalHook,
  })
  for (const [root, year] of [
    [valid, 2022],
    [wrongName, 2023],
    [wrongVersion, 2024],
    [linkedHook, 2025],
  ]) {
    const timestamp = new Date(`${year}-01-01T00:00:00Z`)
    await utimes(root, timestamp, timestamp)
  }

  const commands = await hookCommands()
  const result = await runHookCommand(commands.Stop, '', {
    cwd: temporaryRoot,
    PLUGIN_ROOT: path.join(family, '0.3.2+codex.stale'),
  })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'valid:stop')
  assert.equal(result.stderr, '')
})

test('hook launcher fails open when no trusted current or sibling root exists', async (t) => {
  const { temporaryRoot, family } = await createHookFamily(t)
  await createInstalledHook(family, '9.0.0+codex.20260721010707', {
    manifestName: 'not-the-orchestrator',
  })
  const commands = await hookCommands()
  const result = await runHookCommand(commands.Stop, '{not-json', {
    cwd: temporaryRoot,
    PLUGIN_ROOT: path.join(family, '0.3.2+codex.stale'),
  })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

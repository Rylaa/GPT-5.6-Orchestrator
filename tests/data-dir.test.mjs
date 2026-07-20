import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  deriveInstalledPluginDataDir,
  resolveOrchestratorDataDir,
} from '../lib/data-dir.mjs'

test('resolves explicit, controller, and hook data roots in strict precedence order', () => {
  const homeDir = '/tmp/g56o-home'
  const modulePath = path.join(
    homeDir,
    '.codex/plugins/cache/personal/gpt-5-6-orchestrator/0.3.0/scripts/orchestrator.mjs',
  )
  assert.equal(resolveOrchestratorDataDir({
    explicit: '/tmp/explicit',
    env: { GPT56_ORCHESTRATOR_DATA_DIR: '/tmp/controller', PLUGIN_DATA: '/tmp/hook' },
    modulePath,
    homeDir,
  }), '/tmp/explicit')
  assert.equal(resolveOrchestratorDataDir({
    env: { GPT56_ORCHESTRATOR_DATA_DIR: '/tmp/controller', PLUGIN_DATA: '/tmp/hook' },
    modulePath,
    homeDir,
  }), '/tmp/controller')
  assert.equal(resolveOrchestratorDataDir({
    env: { PLUGIN_DATA: '/tmp/hook' },
    modulePath,
    homeDir,
  }), '/tmp/hook')
})

test('derives the same plugin-managed root from an installed cache path', () => {
  const homeDir = '/tmp/g56o-home'
  const modulePath = path.join(
    homeDir,
    '.codex/plugins/cache/personal/gpt-5-6-orchestrator/0.3.0/scripts/orchestrator.mjs',
  )
  const expected = path.join(homeDir, '.codex/plugins/data/gpt-5-6-orchestrator-personal')
  assert.equal(deriveInstalledPluginDataDir({ modulePath, homeDir }), expected)
  assert.equal(resolveOrchestratorDataDir({ env: {}, modulePath, homeDir }), expected)
})

test('accepts a Codex semver cachebuster in the installed cache path', () => {
  const homeDir = '/tmp/g56o-home'
  assert.equal(deriveInstalledPluginDataDir({
    modulePath: path.join(
      homeDir,
      '.codex',
      'plugins',
      'cache',
      'personal',
      'gpt-5-6-orchestrator',
      '0.3.0+codex.20260720133451',
      'scripts',
      'orchestrator.mjs',
    ),
    homeDir,
  }), path.join(homeDir, '.codex', 'plugins', 'data', 'gpt-5-6-orchestrator-personal'))
})

test('keeps a standalone fallback when the module is not an installed plugin', () => {
  assert.equal(deriveInstalledPluginDataDir({
    modulePath: '/tmp/source/scripts/orchestrator.mjs',
    homeDir: '/tmp/home',
  }), null)
  assert.equal(resolveOrchestratorDataDir({
    env: {}, modulePath: '/tmp/source/scripts/orchestrator.mjs', homeDir: '/tmp/home',
  }), '/tmp/home/.local/share/gpt-5-6-orchestrator')
})

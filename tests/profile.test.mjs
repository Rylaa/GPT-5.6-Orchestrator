import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_THRESHOLDS,
  resolveProfile,
  profileInstructionFile,
  resolveReasoningRequest,
  resolveThreshold,
} from '../lib/profile.mjs'

test('detects Sol and Luna model profiles', () => {
  assert.equal(resolveProfile({ model: 'gpt-5.6-sol' }), 'sol')
  assert.equal(resolveProfile({ model: 'gpt-5.6-luna' }), 'luna')
  assert.equal(resolveProfile({ model: 'preview-sol' }), 'luna')
  assert.equal(resolveProfile({ model: 'preview-luna' }), 'luna')
})

test('defaults unknown or missing models to the lean Luna profile', () => {
  assert.equal(resolveProfile({ model: 'gpt-5.6' }), 'luna')
  assert.equal(resolveProfile({}), 'luna')
})

test('accepts an explicit valid profile override and rejects invalid values', () => {
  assert.equal(resolveProfile({ model: 'gpt-5.6-luna', override: 'sol' }), 'sol')
  assert.equal(resolveProfile({ model: 'gpt-5.6-sol', override: 'auto' }), 'sol')
  assert.throws(
    () => resolveProfile({ model: 'gpt-5.6-sol', override: 'opus' }),
    /profile override/i,
  )
})

test('uses profile defaults and bounded threshold overrides', () => {
  assert.equal(resolveThreshold({ profile: 'sol', env: {} }), DEFAULT_THRESHOLDS.sol)
  assert.equal(resolveThreshold({ profile: 'luna', env: {} }), DEFAULT_THRESHOLDS.luna)
  assert.equal(
    resolveThreshold({
      profile: 'sol',
      env: { CODEX_SOL_FUSION_LEDGER_THRESHOLD_SOL: '2300' },
    }),
    2300,
  )
  assert.equal(
    resolveThreshold({
      profile: 'luna',
      env: {
        CODEX_SOL_FUSION_LEDGER_THRESHOLD: '700',
        CODEX_SOL_FUSION_LEDGER_THRESHOLD_LUNA: '900',
      },
    }),
    700,
  )
  assert.throws(
    () => resolveThreshold({
      profile: 'sol',
      env: { CODEX_SOL_FUSION_LEDGER_THRESHOLD: '../bad' },
    }),
    /threshold/i,
  )
  assert.throws(
    () => resolveThreshold({ profile: 'moon', env: {} }),
    /unknown profile/i,
  )
  assert.throws(
    () => resolveThreshold({
      profile: 'sol',
      env: { CODEX_SOL_FUSION_LEDGER_THRESHOLD: '1000001' },
    }),
    /between 1 and 1000000/i,
  )
})

test('maps only known profiles to instruction files', () => {
  assert.equal(profileInstructionFile('sol'), 'sol-chair.md')
  assert.equal(profileInstructionFile('luna'), 'luna-chair.md')
  assert.throws(() => profileInstructionFile('moon'), /unknown instruction profile/i)
})

test('allowlists model and effort combinations', () => {
  assert.deepEqual(
    resolveReasoningRequest({ model: 'gpt-5.6-sol', effort: 'ultra' }),
    { model: 'gpt-5.6-sol', effort: 'ultra' },
  )
  assert.deepEqual(
    resolveReasoningRequest({ model: 'gpt-5.6-luna' }),
    { model: 'gpt-5.6-luna', effort: 'medium' },
  )
  assert.throws(
    () => resolveReasoningRequest({ model: 'gpt-5.6-luna', effort: 'ultra' }),
    /does not support.*ultra/i,
  )
  assert.throws(
    () => resolveReasoningRequest({ model: 'gpt-5.6-moon', effort: 'high' }),
    /unsupported model/i,
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseKnownSections,
  referencedLedgerIds,
  validateHandoffReport,
  validateTaskContract,
} from '../lib/task-contract.mjs'

const returnFields = [
  '1. Ledger items addressed and scope',
  '2. Evidence and files changed',
  '3. Verification result',
  '4. Risks and unresolved issues',
  '5. Confidence and out-of-scope findings',
].join('\n')

function detailedTask(ledgerItems = 'F2, F3') {
  return [
    `## Ledger items: ${ledgerItems}`,
    '## Objective: Inspect the controller.',
    '## Inputs:',
    '- Repository root: /tmp/repo',
    '- Current branch: main',
    '## Allowed files/systems: read-only repository files',
    '## Acceptance checks: return concrete evidence',
    '## Return exactly:',
    returnFields,
  ].join('\n')
}

test('parses ordinary colon-bearing bullets without terminating their section', () => {
  const result = validateTaskContract({
    task: detailedTask(),
    ledger: { ids: new Set(['F2', 'F3']) },
  })
  assert.deepEqual(result.ledgerIds, ['F2', 'F3'])
})

test('ledger ranges never cross lines and malformed ranges fail clearly', () => {
  assert.deepEqual(referencedLedgerIds('RV4\nRC1'), ['RV4', 'RC1'])
  assert.deepEqual(referencedLedgerIds('F2-F4, 1-2'), ['F2', 'F3', 'F4', '1', '2'])
  assert.throws(() => referencedLedgerIds('F4-RC1'), /invalid ledger item range/i)
})

test('rejects duplicate sections and ignores heading examples inside fences', () => {
  assert.throws(() => validateTaskContract({
    task: `${detailedTask()}\n## Inputs: duplicate`,
    ledger: { ids: new Set(['F2', 'F3']) },
  }), /duplicate inputs/i)
  const sections = parseKnownSections([
    '## Objective: real',
    '```md',
    '## Objective: example',
    '```',
  ].join('\n'), ['objective'])
  assert.match(sections.get('objective'), /example/)
})

test('requires five distinct non-empty handoff fields', () => {
  const valid = validateHandoffReport([
    '## Ledger items addressed and scope', 'F1',
    '## Evidence and files changed', 'none',
    '## Verification result', 'pass',
    '## Risks and unresolved issues', 'none',
    '## Confidence and out-of-scope findings', 'high',
  ].join('\n'))
  assert.equal(valid.valid, true)
  assert.equal(validateHandoffReport('Verification result: pass').valid, false)
})

test('accepts common Markdown separators after exact handoff field names', () => {
  const report = [
    '1. Ledger items addressed and scope — F2 and FA4.',
    '2. Evidence and files changed – proof inspected; no files changed.',
    '3. Verification result - passed.',
    '4. Risks and unresolved issues: none.',
    '5. Confidence and out-of-scope findings — high; none.',
  ].join('\n')
  assert.equal(validateHandoffReport(report).valid, true)
})

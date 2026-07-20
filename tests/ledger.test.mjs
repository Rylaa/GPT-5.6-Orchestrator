import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_LEDGER_BYTES,
  findLedger,
  parseLedger,
  patchTouchesOnlyLedger,
  readLedger,
} from '../lib/ledger.mjs'

async function makeTempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'codex-sol-fusion-ledger-'))
}

test('finds a ledger upward through a repository', async () => {
  const root = await makeTempDir()
  const nested = path.join(root, 'packages', 'app')
  await mkdir(path.join(root, '.git'))
  await mkdir(path.join(root, '.workflow'))
  await mkdir(nested, { recursive: true })
  const ledgerPath = path.join(root, '.workflow', 'LEDGER.md')
  await writeFile(ledgerPath, '- [ ] 1. Ship it\n')

  assert.equal(await findLedger(nested), await realpath(ledgerPath))
})

test('handles invalid roots and regular-file requirements', async () => {
  assert.equal(await findLedger(''), null)
  const root = await makeTempDir()
  await assert.rejects(() => readLedger(root), /regular file/i)
})

test('treats a .git file as the worktree boundary', async () => {
  const outer = await makeTempDir()
  const worktree = path.join(outer, 'worktree')
  const nested = path.join(worktree, 'src')
  await mkdir(path.join(outer, '.workflow'))
  await writeFile(path.join(outer, '.workflow', 'LEDGER.md'), '- [ ] wrong\n')
  await mkdir(nested, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir: ../actual.git/worktrees/test\n')

  assert.equal(await findLedger(nested), null)
})

test('without git, an outside-home cwd cannot inherit a parent ledger', async () => {
  const outer = await makeTempDir()
  const cwd = path.join(outer, 'isolated')
  await mkdir(path.join(outer, '.workflow'))
  await mkdir(cwd)
  await writeFile(path.join(outer, '.workflow', 'LEDGER.md'), '- [ ] unrelated\n')

  assert.equal(await findLedger(cwd), null)
})

test('without git, an inside-home cwd can find its nearest home-scoped ledger', async (t) => {
  let root
  try {
    root = await mkdtemp(path.join(os.homedir(), '.codex-sol-fusion-ledger-'))
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('sandbox does not permit temporary fixtures in the home directory')
      return
    }
    throw error
  }
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'nested')
  await mkdir(path.join(root, '.workflow'))
  await mkdir(cwd)
  const ledgerPath = path.join(root, '.workflow', 'LEDGER.md')
  await writeFile(ledgerPath, '- [ ] home scoped\n')

  assert.equal(await findLedger(cwd), await realpath(ledgerPath))
})

test('rejects symlinked and oversized ledgers', async () => {
  const root = await makeTempDir()
  await mkdir(path.join(root, '.git'))
  await mkdir(path.join(root, '.workflow'))
  const outside = path.join(root, 'outside.md')
  const ledgerPath = path.join(root, '.workflow', 'LEDGER.md')
  await writeFile(outside, '- [ ] escaped\n')
  await symlink(outside, ledgerPath)
  assert.equal(await findLedger(root), null)

  const largePath = path.join(root, 'large.md')
  await writeFile(largePath, 'x'.repeat(MAX_LEDGER_BYTES + 1))
  await assert.rejects(() => readLedger(largePath), /too large/i)
})

test('rejects a symlinked workflow directory that escapes the repository', async () => {
  const root = await makeTempDir()
  const outside = await makeTempDir()
  await mkdir(path.join(root, '.git'))
  await writeFile(path.join(outside, 'LEDGER.md'), '- [ ] outside secret\n')
  await symlink(outside, path.join(root, '.workflow'))

  assert.equal(await findLedger(root), null)
})

test('parses open, complete, and explicitly deferred items', () => {
  const parsed = parseLedger(`
- [ ] 1. Open item
- [x] 2. Complete item
* [X] 3. Complete too
- [~] deferred: user-approved later
- [~] not actually deferred
- [ ]
`)
  assert.deepEqual(parsed.openItems, [
    '1. Open item',
    'not actually deferred',
    '(unnamed requirement)',
  ])
  assert.equal(parsed.totalItems, 6)
  assert.equal(parsed.closedItems, 3)
})

test('ignores fenced checkbox examples and requires the exact user-approved defer marker', () => {
  const parsed = parseLedger(`
- [ ] R1. Real requirement
\`\`\`md
- [x] R9. Example only
\`\`\`
~~~text
- [ ] C1. Example only
~~~
- [~] deferred: user approved verbally
- [~] deferred: user-approved in planning
`)
  assert.equal(parsed.totalItems, 3)
  assert.equal(parsed.closedItems, 1)
  assert.deepEqual(parsed.openItems, [
    'R1. Real requirement',
    'deferred: user approved verbally',
  ])
  assert.deepEqual(parsed.items.map((item) => item.id), ['R1', null, null])
})

test('extracts Fable numeric IDs and the final V item consistently', () => {
  const parsed = parseLedger(`
- [ ] 1. First requirement
- [x] 2) Second requirement
- [ ] V. Fresh-eyes closure
`)
  assert.deepEqual(parsed.items.map((item) => item.id), ['1', '2', 'V'])
})

test('allows a bootstrap patch only when every target is the ledger', () => {
  const onlyLedger = `*** Begin Patch
*** Add File: .workflow/LEDGER.md
+- [ ] 1. Requirement
*** End Patch`
  const mixedPatch = `*** Begin Patch
*** Add File: .workflow/LEDGER.md
+- [ ] 1. Requirement
*** Update File: src/app.js
@@
-old
+new
*** End Patch`

  assert.equal(patchTouchesOnlyLedger(onlyLedger), true)
  assert.equal(patchTouchesOnlyLedger(mixedPatch), false)
  assert.equal(patchTouchesOnlyLedger('not a patch'), false)
  assert.equal(patchTouchesOnlyLedger(null), false)
  assert.equal(patchTouchesOnlyLedger(
    '*** Update File: packages\\app\\.workflow\\LEDGER.md',
  ), true)
})

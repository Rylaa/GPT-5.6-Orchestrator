#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function collect(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(target))
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(target)
  }
  return files
}

const files = (await Promise.all(
  ['hooks', 'lib', 'scripts', 'tests'].map((name) => collect(path.join(root, name))),
)).flat().sort()
for (const file of files) await execFileAsync(process.execPath, ['--check', file])
process.stdout.write(`Syntax check passed for ${files.length} modules.\n`)

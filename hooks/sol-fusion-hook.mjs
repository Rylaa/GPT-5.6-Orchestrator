#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { handleHook } from '../lib/hook-handler.mjs'

const MAX_INPUT_BYTES = 1_000_000

async function readStdin() {
  let size = 0
  const chunks = []
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT_BYTES) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

async function main() {
  const action = process.argv[2]
  const payload = await readStdin()
  if (!payload) return
  const hookDirectory = path.dirname(fileURLToPath(import.meta.url))
  const pluginRoot = process.env.PLUGIN_ROOT || path.dirname(hookDirectory)
  const output = await handleHook(action, payload, {
    env: process.env,
    pluginRoot,
    dataDir: process.env.PLUGIN_DATA,
  })
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
}

await main().catch(() => {})

import os from 'node:os'
import path from 'node:path'

const SAFE_COMPONENT = /^[a-z0-9][a-z0-9._+-]*$/i

function normalizedPath(value) {
  const text = String(value || '').trim()
  return text ? path.resolve(text) : null
}

export function deriveInstalledPluginDataDir({ modulePath, homeDir = os.homedir() } = {}) {
  const resolvedModule = normalizedPath(modulePath)
  if (!resolvedModule) return null
  const cacheRoot = path.resolve(homeDir, '.codex', 'plugins', 'cache')
  const relative = path.relative(cacheRoot, resolvedModule)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const [marketplace, pluginName, version, ...rest] = relative.split(path.sep)
  if (
    !marketplace
    || !pluginName
    || !version
    || rest.length === 0
    || !SAFE_COMPONENT.test(marketplace)
    || !SAFE_COMPONENT.test(pluginName)
    || !SAFE_COMPONENT.test(version)
  ) return null
  return path.resolve(homeDir, '.codex', 'plugins', 'data', `${pluginName}-${marketplace}`)
}

export function resolveOrchestratorDataDir({
  explicit,
  env = process.env,
  modulePath,
  homeDir = os.homedir(),
} = {}) {
  return normalizedPath(explicit)
    || normalizedPath(env.GPT56_ORCHESTRATOR_DATA_DIR)
    || normalizedPath(env.PLUGIN_DATA)
    || deriveInstalledPluginDataDir({ modulePath, homeDir })
    || path.resolve(homeDir, '.local', 'share', 'gpt-5-6-orchestrator')
}

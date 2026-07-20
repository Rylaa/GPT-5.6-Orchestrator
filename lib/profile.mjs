const MODEL_EFFORTS = Object.freeze({
  'gpt-5.6-sol': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-5.6-terra': new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  'gpt-5.6-luna': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
})

const DEFAULT_EFFORTS = Object.freeze({
  'gpt-5.6-sol': 'high',
  'gpt-5.6-terra': 'max',
  'gpt-5.6-luna': 'max',
})

export const DEFAULT_THRESHOLDS = Object.freeze({
  sol: 1_500,
  terra: 2_500,
  luna: 4_000,
})

const MAX_THRESHOLD = 1_000_000

export function resolveProfile({ model = '', override = 'auto' } = {}) {
  const normalizedOverride = String(override || 'auto').trim().toLowerCase()
  if (!['auto', 'sol', 'terra', 'luna'].includes(normalizedOverride)) {
    throw new RangeError(`Unsupported profile override: ${override}`)
  }
  if (normalizedOverride !== 'auto') return normalizedOverride

  const normalizedModel = String(model || '').trim().toLowerCase()
  if (normalizedModel === 'gpt-5.6-sol') return 'sol'
  if (normalizedModel === 'gpt-5.6-terra') return 'terra'
  if (normalizedModel === 'gpt-5.6-luna') return 'luna'
  return 'terra'
}

function parseThreshold(value, name) {
  if (value === undefined || value === null || value === '') return null
  if (!/^\d+$/.test(String(value))) {
    throw new RangeError(`${name} threshold must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_THRESHOLD) {
    throw new RangeError(`${name} threshold must be between 1 and ${MAX_THRESHOLD}`)
  }
  return parsed
}

export function resolveThreshold({ profile, env = process.env }) {
  if (!Object.hasOwn(DEFAULT_THRESHOLDS, profile)) {
    throw new RangeError(`Unknown profile for threshold: ${profile}`)
  }
  const globalOverride = parseThreshold(
    env.GPT56_ORCHESTRATOR_LEDGER_THRESHOLD,
    'Global ledger',
  )
  if (globalOverride !== null) return globalOverride

  const profileKey = `GPT56_ORCHESTRATOR_LEDGER_THRESHOLD_${profile.toUpperCase()}`
  const profileOverride = parseThreshold(env[profileKey], `${profile} ledger`)
  return profileOverride ?? DEFAULT_THRESHOLDS[profile]
}

export function resolveReasoningRequest({ model, effort } = {}) {
  const normalizedModel = String(model || '').trim().toLowerCase()
  const supportedEfforts = MODEL_EFFORTS[normalizedModel]
  if (!supportedEfforts) throw new RangeError(`Unsupported model: ${model}`)

  const normalizedEffort = String(effort || DEFAULT_EFFORTS[normalizedModel])
    .trim()
    .toLowerCase()
  if (!supportedEfforts.has(normalizedEffort)) {
    throw new RangeError(`${normalizedModel} does not support reasoning effort ${normalizedEffort}`)
  }
  return { model: normalizedModel, effort: normalizedEffort }
}

export const HANDOFF_FIELDS = Object.freeze([
  'Ledger items addressed and scope',
  'Evidence and files changed',
  'Verification result',
  'Risks and unresolved issues',
  'Confidence and out-of-scope findings',
])

const TASK_SECTION_NAMES = Object.freeze([
  'ledger items',
  'objective',
  'requirements',
  'constraints',
  'unknowns',
  'dependencies',
  'risks',
  'inputs',
  'allowed files',
  'allowed files/systems',
  'allowed scope',
  'acceptance checks',
  'return exactly',
])

function normalizeLabel(value) {
  return String(value || '')
    .replaceAll('**', '')
    .replaceAll('__', '')
    .replace(/\s+#+\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function headerMatch(line, knownNames) {
  let candidate = String(line || '').trim()
  candidate = candidate.replace(/^#{1,6}\s+/, '')
  candidate = candidate.replace(/^\d+[.)]\s+/, '')
  candidate = candidate.replaceAll('**', '').replaceAll('__', '').trim()
  const separator = candidate.match(/^(.*?)(?::\s*|\s*[—–]\s*|\s+-\s+)(.*)$/u)
  const label = normalizeLabel(separator ? separator[1] : candidate)
  if (!knownNames.has(label)) return null
  return {
    label,
    inlineValue: separator ? separator[2].trim() : '',
  }
}

export function parseKnownSections(content, names, { rejectDuplicates = true } = {}) {
  const knownNames = new Set(names.map(normalizeLabel))
  const sections = new Map()
  let current = null
  let fenced = false
  for (const line of String(content || '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      if (current) current.lines.push(line)
      continue
    }
    const match = fenced ? null : headerMatch(line, knownNames)
    if (match) {
      if (sections.has(match.label) && rejectDuplicates) {
        throw new Error(`Detailed task contract has duplicate ${match.label} sections`)
      }
      current = { lines: [] }
      if (match.inlineValue) current.lines.push(match.inlineValue)
      sections.set(match.label, current)
      continue
    }
    if (current) current.lines.push(line)
  }
  return new Map([...sections].map(([name, section]) => [
    name,
    section.lines.join('\n').trim(),
  ]))
}

export function referencedLedgerIds(value) {
  const source = String(value || '').toUpperCase()
  const ids = []
  const ranges = /\b([A-Z]*)(\d+)[ \t]*-[ \t]*([A-Z]*)(\d+)\b/g
  for (const match of source.matchAll(ranges)) {
    const leftPrefix = match[1]
    const rightPrefix = match[3] || leftPrefix
    const start = Number(match[2])
    const end = Number(match[4])
    if (leftPrefix !== rightPrefix || end < start || end - start > 100) {
      throw new Error(`Invalid ledger item range: ${match[0]}`)
    }
    for (let current = start; current <= end; current += 1) {
      ids.push(`${leftPrefix}${current}`)
    }
  }
  const withoutRanges = source.replace(ranges, ' ')
  ids.push(...(withoutRanges.match(/\b(?:[A-Z]+\d+|V|\d+)\b/g) || []))
  return [...new Set(ids)]
}

export function validateTaskContract({ task, ledger = null, detailedThreshold = 1_500 }) {
  const normalizedTask = String(task || '')
  const sections = parseKnownSections(normalizedTask, TASK_SECTION_NAMES)
  const detailed = normalizedTask.length > detailedThreshold || sections.size > 0
  if (!detailed) return { detailed: false, ledgerIds: [] }
  if (normalizedTask.length > detailedThreshold && !ledger) {
    throw new Error(`Detailed task files above ${detailedThreshold} characters require a ledger`)
  }

  const required = [
    ['ledger items'],
    ['objective'],
    ['inputs'],
    ['allowed files', 'allowed files/systems', 'allowed scope'],
    ['acceptance checks'],
  ]
  for (const alternatives of required) {
    if (!alternatives.some((name) => sections.get(name))) {
      throw new Error(`Detailed task contract is missing ${alternatives[0]}`)
    }
  }
  const returnContract = sections.get('return exactly') || ''
  if (!HANDOFF_FIELDS.every((field) => returnContract.includes(field))) {
    throw new Error('Detailed task contract must require the exact five-field return')
  }
  const ids = referencedLedgerIds(sections.get('ledger items'))
  if (ids.length === 0) throw new Error('Detailed task contract must cite ledger item IDs')
  if (ledger) {
    const missing = ids.filter((id) => !ledger.ids.has(id))
    if (missing.length) throw new Error(`Task cites ledger IDs that do not exist: ${missing.join(', ')}`)
  }
  return { detailed: true, ledgerIds: ids }
}

export function validateHandoffReport(report) {
  try {
    const sections = parseKnownSections(report, HANDOFF_FIELDS)
    const missing = HANDOFF_FIELDS.filter((field) => !sections.get(normalizeLabel(field)))
    return {
      valid: missing.length === 0,
      fields: HANDOFF_FIELDS.filter((field) => !missing.includes(field)),
      missing,
    }
  } catch (error) {
    return { valid: false, fields: [], missing: HANDOFF_FIELDS, reason: error.message }
  }
}

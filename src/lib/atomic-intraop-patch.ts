import { parseAirwayDeviceEntries } from "@lospor/core/airway-device-entries"

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null

const recordTime = (value: unknown): number | null => {
  const item = asRecord(value)
  if (!item) return null
  for (const key of ["endedAt", "failedAt", "insertedAt", "updatedAt", "ts"]) {
    const candidate = item[key]
    if (typeof candidate !== "string") continue
    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const isTerminalRecord = (value: unknown): boolean => {
  const item = asRecord(value)
  return item?.status === "failed" || item?.status === "replaced" || item?.failed === true
}

/** Keep a newer terminal record from being resurrected by an offline retry. */
const incomingRecordWins = (current: unknown, incoming: unknown): boolean => {
  const currentAt = recordTime(current)
  const incomingAt = recordTime(incoming)
  if (currentAt != null && incomingAt != null && incomingAt < currentAt) return false
  if (currentAt != null && incomingAt == null && isTerminalRecord(current) && !isTerminalRecord(incoming)) return false
  return true
}

/**
 * Merge the additive part of an atomic airway/vascular event with the latest
 * server record. Smart airway and vascular actions are insert/replace actions;
 * they never use this path to erase a previously recorded line or device. A
 * stale client may therefore be safely rebased while the event keeps its
 * original clinical payload and idempotency key.
 */
export function rebaseAtomicIntraopPatch(
  current: JsonRecord,
  incoming: JsonRecord,
): JsonRecord {
  const next: JsonRecord = { ...incoming }

  if (incoming.airwayNotApplicable === true) return next

  if (Array.isArray(incoming.airwayDeviceEntries)) {
    const currentEntries = parseAirwayDeviceEntries(current.airwayDeviceEntries)
    const incomingEntries = parseAirwayDeviceEntries(incoming.airwayDeviceEntries)
    const merged = new Map(currentEntries.map(entry => [entry.id, entry]))
    for (const entry of incomingEntries) {
      const currentEntry = merged.get(entry.id)
      if (!currentEntry || incomingRecordWins(currentEntry, entry)) merged.set(entry.id, entry)
    }
    next.airwayDeviceEntries = [...merged.values()]
  }

  if (Array.isArray(incoming.airwayDevices)) {
    const currentDevices = Array.isArray(current.airwayDevices)
      ? current.airwayDevices.filter((value): value is string => typeof value === "string")
      : []
    const incomingDevices = incoming.airwayDevices.filter((value): value is string => typeof value === "string")
    next.airwayDevices = [...new Set([...currentDevices, ...incomingDevices])]
  }

  if (Array.isArray(incoming.airwayTools)) {
    const currentTools = Array.isArray(current.airwayTools)
      ? current.airwayTools.filter((value): value is string => typeof value === "string")
      : []
    const incomingTools = incoming.airwayTools.filter((value): value is string => typeof value === "string")
    next.airwayTools = [...new Set([...currentTools, ...incomingTools])]
  }

  // Context-link answers can add an exact technique (and, for a peripheral
  // block or unilateral spinal, its side) through the same atomic event path.
  // Union these additive fields as well, so a stale web/phone write cannot
  // erase a technique selected on the other client.
  if (Array.isArray(incoming.techniques)) {
    const currentTechniques = Array.isArray(current.techniques)
      ? current.techniques.filter((value): value is string => typeof value === "string")
      : []
    const incomingTechniques = incoming.techniques.filter((value): value is string => typeof value === "string")
    next.techniques = [...new Set([...currentTechniques, ...incomingTechniques])]
  }

  if (incoming.techniqueSides && typeof incoming.techniqueSides === "object" && !Array.isArray(incoming.techniqueSides)) {
    const currentSides = asRecord(current.techniqueSides) ?? {}
    const incomingSides = asRecord(incoming.techniqueSides) ?? {}
    const techniques = Array.isArray(next.techniques)
      ? new Set(next.techniques.filter((value): value is string => typeof value === "string"))
      : new Set<string>()
    next.techniqueSides = Object.fromEntries(Object.entries({ ...currentSides, ...incomingSides })
      .filter(([code]) => techniques.size === 0 || techniques.has(code)))
  }

  if (Array.isArray(incoming.vascularAccesses)) {
    const currentAccesses = Array.isArray(current.vascularAccesses) ? current.vascularAccesses : []
    const incomingAccesses = incoming.vascularAccesses
    const merged = new Map<string, unknown>()
    const keyFor = (value: unknown, index: number): string => {
      const item = asRecord(value)
      if (typeof item?.id === "string" && item.id) return `id:${item.id}`
      if (typeof item?.site === "string" && item.site) {
        return `site:${item.site}|${String(item.insertedAt ?? "")}|${String(item.size ?? "")}|${index}`
      }
      return `value:${JSON.stringify(value)}|${index}`
    }
    currentAccesses.forEach((value, index) => merged.set(keyFor(value, index), value))
    incomingAccesses.forEach((value, index) => {
      const key = keyFor(value, index)
      const currentValue = merged.get(key)
      if (currentValue === undefined || incomingRecordWins(currentValue, value)) merged.set(key, value)
    })
    next.vascularAccesses = [...merged.values()]
  }

  return next
}

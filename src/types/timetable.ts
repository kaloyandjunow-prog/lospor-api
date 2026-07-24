import type {
  AgentSegment,
  ClinicalEvent,
  EventType,
  GasSettingsSegment,
  LogEvent as CoreLogEvent,
  PhaseSegment,
  PositionSegment,
  TimetableData,
  TimetableDrug,
  TimetableFluid,
  TimetableInfusion,
  VitalsEntry,
} from "@lospor/core/intraop-types"

export type {
  AgentSegment,
  ClinicalEvent,
  GasSettingsSegment,
  PhaseSegment,
  PositionSegment,
  TimetableData,
  TimetableDrug,
  TimetableFluid,
  TimetableInfusion,
  VitalsEntry,
}

// The API accepts old projected snapshots whose events predate required ids
// and timestamps. New live events use CoreLogEvent; this boundary type keeps
// legacy reads explicit without weakening Core's canonical event contract.
export type LogEvent = Partial<Omit<CoreLogEvent, "type">> & {
  type?: EventType | string
}

export type LegacyKeyEvents = Partial<TimetableData> & {
  log?: LogEvent[]
  legacyUnanchored?: boolean
}

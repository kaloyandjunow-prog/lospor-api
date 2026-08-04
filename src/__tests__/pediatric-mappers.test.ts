import { describe, expect, it } from "vitest"
import { mapPreop, mapPreopUpdate } from "@/app/v1/cases/_mappers"

describe("pediatric preop persistence", () => {
  it("stores precise age, derives completed years and BSA, and suppresses adult scores", () => {
    const result = mapPreop({
      clinicalMode: "PEDIATRIC",
      ageValue: 18,
      ageUnit: "MONTHS",
      heightCm: 82,
      weightKg: 11,
      rcriScore: 3,
      apfelScore: 4,
      stopBangScore: 7,
    })

    expect(result.ageYears).toBe(1)
    expect(result.bodySurfaceAreaM2).toBeCloseTo(0.5006, 4)
    expect(result.rcriScore).toBeNull()
    expect(result.apfelScore).toBeNull()
    expect(result.stopBangScore).toBeNull()
  })

  it("recomputes derived body size from stored values during a partial save", () => {
    const result = mapPreopUpdate(
      {
        clinicalMode: "PEDIATRIC",
        weightKg: 12,
      },
      {
        ageValue: 18,
        ageUnit: "MONTHS",
        heightCm: 82,
        weightKg: 11,
      },
    )

    expect(result.bmi).toBeCloseTo(12 / (0.82 ** 2), 4)
    expect(result.bodySurfaceAreaM2).toBeCloseTo(Math.sqrt(82 * 12 / 3600), 4)
    expect("heightCm" in result).toBe(false)
  })

  it("recomputes POVOC from the stored pediatric age and the changed factor", () => {
    const result = mapPreopUpdate(
      {
        clinicalMode: "PEDIATRIC",
        povocHistory: true,
      },
      {
        ageValue: 10,
        ageUnit: "YEARS",
        povocSurgeryAtLeast30Minutes: true,
        povocStrabismusSurgery: false,
        povocHistory: false,
      },
    )

    expect(result.povocScore).toBe(3)
    expect(result.povocRiskPercent).toBe(55)
    expect(result.povocAgeAtLeast3Years).toBe(true)
  })

  it("clears every adult-only risk value when a case switches to pediatric mode", () => {
    const result = mapPreopUpdate(
      { clinicalMode: "PEDIATRIC" },
      {
        ageValue: 12,
        ageUnit: "YEARS",
        rcriIschemicHeart: true,
        rcriScore: 1,
        apfelScore: 2,
        stopBangScore: 3,
      },
    )

    expect(result).toMatchObject({
      rcriIschemicHeart: false,
      rcriScore: null,
      apfelScore: null,
      stopBangScore: null,
    })
  })
})

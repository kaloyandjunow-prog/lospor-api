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
    // The risk is derived where it is shown, never stored.
    expect(result.povocRiskPercent).toBeNull()
    expect(result.povocAgeAtLeast3Years).toBe(true)
  })

  // 10.0.0: an unanswered POVOC question was stored as "no" and the child
  // scored on it. Not asked stays not asked, and there is no score until all
  // three are answered.
  it("keeps an unanswered POVOC question unanswered, and has no score until all three are in", () => {
    const partial = mapPreop({ clinicalMode: "PEDIATRIC", ageValue: 4, ageUnit: "YEARS", povocHistory: true })
    expect(partial.povocHistory).toBe(true)
    expect(partial.povocSurgeryAtLeast30Minutes).toBeNull()
    expect(partial.povocStrabismusSurgery).toBeNull()
    expect(partial.povocScore).toBeNull()
    expect(partial.povocAgeAtLeast3Years).toBe(true)

    const answered = mapPreop({ clinicalMode: "PEDIATRIC", ageValue: 4, ageUnit: "YEARS", povocHistory: true, povocSurgeryAtLeast30Minutes: false, povocStrabismusSurgery: false })
    expect(answered.povocScore).toBe(2)
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

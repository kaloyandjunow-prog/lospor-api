import { describe, expect, it } from "vitest"
import {
  artifactExpectation,
  assertBundledBaselineAuditDetail,
  assertExactBundledBaselineArtifacts,
  bundledBaselineAuditDetail,
  canonicalBundledBaselineJson,
  computeBundledBaselineArtifacts,
} from "./bundled-baseline-contract"

describe("bundled clinical baseline release contract", () => {
  it("locks exact identities, rule counts, keys, content, sources and evidence digests", () => {
    const artifacts = computeBundledBaselineArtifacts()
    expect(artifacts.map(artifact => ({
      clinicalMode: artifact.identity.clinicalMode,
      ...artifactExpectation(artifact),
    }))).toMatchInlineSnapshot(`
      [
        {
          "clinicalMode": "ADULT",
          "contentSha256": "030a1f80784f367def47e828c0253e07f55e7ec6bbcc73437004844ccfdb2521",
          "descriptorSha256": "6505bd4cc51ac5aa12ccc40de9256eed5ff3b8101b113d83d5d77b1ee9c7d3b7",
          "diffSha256": "b241c1c8ccdffde24a4b442758ab3bd25bb1141da0519f4d00fcbc6a246fd463",
          "ruleCount": 251,
          "ruleKeysSha256": "3e6b29c596d4afb8d2e634b4dfd07ba047bbf08c723de4ee3642bbf79fa2be98",
          "sourceRefsSha256": "84229bc5f7cd34cdd7dc08cd29b0e0a73d75d06729e56418dd08cb5e765ea560",
        },
        {
          "clinicalMode": "PEDIATRIC",
          "contentSha256": "233323da828092f572696c3363a06cee51420c8b66183acb0e5226ae27fd95c3",
          "descriptorSha256": "e9b6010f726809f2295ff5b5889e563cc390260a01c0419d1668327579056c50",
          "diffSha256": "b23b3c0ad39ef99ed7efea0fd4b98358cc380724cb85b0dbfda42431e948f45e",
          "ruleCount": 335,
          "ruleKeysSha256": "b2575d605f6a486c29661d5f18098177243774cfd79b028d9b8a80f1fe930716",
          "sourceRefsSha256": "f8168d43ac95a0be5aa2f2c55de438b393bebe0d73c87fe1ef06f8c7b81389f9",
        },
      ]
    `)
    expect(() => assertExactBundledBaselineArtifacts(artifacts)).not.toThrow()
    expect(artifacts.every(artifact => (
      artifact.exactDiff.schemaVersion === 2
      && artifact.exactDiff.hashCanonicalization === "UTF16_CODE_UNIT_V1"
    ))).toBe(true)
  })

  it("uses the release-versioned locale-independent byte order", () => {
    expect(canonicalBundledBaselineJson({ a: 1, Z: 2, "ä": 3, _: 4 }))
      .toBe('{"Z":2,"_":4,"a":1,"ä":3}')
  })

  it("rejects any release digest drift", () => {
    const artifacts = computeBundledBaselineArtifacts()
    const tampered = artifacts.map((artifact, index) => index === 0
      ? { ...artifact, contentSha256: "0".repeat(64) }
      : artifact)
    expect(() => assertExactBundledBaselineArtifacts(tampered)).toThrow(/digest mismatch/)
  })

  it("keeps audit evidence exact and bounded without raw clinical content", () => {
    const detail = bundledBaselineAuditDetail(computeBundledBaselineArtifacts()[0])
    expect(() => assertBundledBaselineAuditDetail(detail, detail)).not.toThrow()
    expect(JSON.stringify(detail).length).toBeLessThan(2_048)
    expect(detail).not.toHaveProperty("payload")
    expect(detail).not.toHaveProperty("sourceRefs")
    expect(() => assertBundledBaselineAuditDetail({ ...detail, payload: {} })).toThrow(/bounded/)
  })
})

import { describe, expect, it } from "vitest"
import { jpegOrientation, rotationInstruction } from "./jpeg-orientation"

/** A minimal JPEG: SOI, an APP1 Exif block with one IFD0 entry, then SOS. */
function jpeg(orientation: number | null, little = false): Uint8Array {
  const u16 = (n: number) => little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]
  const u32 = (n: number) => little ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  const entries = orientation == null ? [] : [...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0]
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(orientation == null ? 0 : 1), ...entries, ...u32(0)]
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const length = app1.length + 2
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...app1, 0xff, 0xda, 0, 2])
}

describe("jpegOrientation (10.4.1)", () => {
  it("reads the tag a phone writes for a portrait photo, either byte order", () => {
    expect(jpegOrientation(jpeg(6))).toBe(6)
    expect(jpegOrientation(jpeg(8, true))).toBe(8)
    expect(jpegOrientation(jpeg(1))).toBe(1)
  })

  it("is null for an image without the tag, or not a JPEG", () => {
    expect(jpegOrientation(jpeg(null))).toBeNull()
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
  })

  it("never runs past a truncated header", () => {
    const cut = jpeg(6).subarray(0, 20)
    expect(jpegOrientation(cut)).toBeNull()
  })
})

describe("rotationInstruction", () => {
  it("tells the model how to turn a sideways photo, and says nothing for an upright one", () => {
    expect(rotationInstruction(6)).toMatch(/90 degrees clockwise/)
    expect(rotationInstruction(8)).toMatch(/counter-clockwise/)
    expect(rotationInstruction(3)).toMatch(/180 degrees/)
    expect(rotationInstruction(1)).toBeNull()
    expect(rotationInstruction(null)).toBeNull()
  })
})

/**
 * The EXIF orientation of a JPEG, read from its bytes (10.4.1).
 *
 * A phone stores a portrait photo with its pixels sideways and an EXIF tag
 * saying how to turn it. The AI provider does not apply that tag, so the model
 * read a lab report table at 90 degrees and paired values with the wrong rows
 * (2026-11-14: WBC 19 for 34.57, MCV 74 for 89 on the appliance). The clients
 * now send upright pixels; this lets the server tell the model how to turn an
 * image from a client that does not.
 *
 * Pure: no image library, only the APP1/Exif header is parsed.
 */

/** 1 (as stored) to 8, or null when the image is not a JPEG or carries no tag. */
export function jpegOrientation(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    // Start of scan or end of image: no more headers.
    if (marker === 0xda || marker === 0xd9) return null
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2) return null
    if (marker === 0xe1) {
      const found = exifOrientation(bytes, offset + 4, offset + 2 + length)
      if (found !== undefined) return found
    }
    offset += 2 + length
  }
  return null
}

function exifOrientation(bytes: Uint8Array, start: number, end: number): number | null | undefined {
  // "Exif\0\0", then a TIFF header.
  if (end > bytes.length || end - start < 14) return undefined
  if (String.fromCharCode(...bytes.subarray(start, start + 4)) !== "Exif") return undefined
  const tiff = start + 6
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
  if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return null
  const u16 = (at: number) => little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]
  const u32 = (at: number) => little
    ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
    : ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return null
  const entries = u16(ifd)
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return null
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : null
    }
  }
  return null
}

/** What to tell the model about an image stored turned, or null when it is upright. */
export function rotationInstruction(orientation: number | null): string | null {
  const turn = orientation === 6 || orientation === 5 ? "90 degrees clockwise"
    : orientation === 8 || orientation === 7 ? "90 degrees counter-clockwise"
      : orientation === 3 || orientation === 4 ? "180 degrees"
        : null
  if (!turn) return null
  return `NOTE: this photograph is stored turned. Its pixels must be turned ${turn} to be upright. Read it as it would appear after that turn: rows run across the page.`
}

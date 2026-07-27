import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let root = ""
const originalDriver = process.env.RESEARCH_EXPORT_STORAGE_DRIVER
const originalDirectory = process.env.RESEARCH_EXPORT_STORAGE_DIR
const originalVercel = process.env.VERCEL

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(result.value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

describe("research export filesystem storage", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lospor-research-export-"))
    process.env.RESEARCH_EXPORT_STORAGE_DRIVER = "filesystem"
    process.env.RESEARCH_EXPORT_STORAGE_DIR = root
    delete process.env.VERCEL
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    if (originalDriver === undefined) delete process.env.RESEARCH_EXPORT_STORAGE_DRIVER
    else process.env.RESEARCH_EXPORT_STORAGE_DRIVER = originalDriver
    if (originalDirectory === undefined) delete process.env.RESEARCH_EXPORT_STORAGE_DIR
    else process.env.RESEARCH_EXPORT_STORAGE_DIR = originalDirectory
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel
  })

  it("creates, reads, verifies size, and removes an immutable artifact", async () => {
    const { researchExportStorage } = await import("./export-storage")
    const storage = researchExportStorage()
    const sink = await storage.create("export-1/file.json", "application/json")
    sink.writable.end('{"ok":true}')
    await sink.done

    const artifact = await storage.open("export-1/file.json")
    expect(artifact.contentLength).toBe(11)
    expect(await readStream(artifact.stream)).toBe('{"ok":true}')

    const duplicate = await storage.create("export-1/file.json", "application/json")
    duplicate.writable.end("replacement")
    await expect(duplicate.done).rejects.toBeDefined()

    await storage.remove("export-1/file.json")
    await expect(storage.open("export-1/file.json")).rejects.toBeDefined()
  })

  it("rejects keys that escape the configured artifact root", async () => {
    const { researchExportStorage } = await import("./export-storage")
    await expect(researchExportStorage().create("../outside.json", "application/json"))
      .rejects.toThrow("INVALID_EXPORT_ARTIFACT_KEY")
  })
})

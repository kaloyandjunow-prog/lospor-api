import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rm, stat } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { PassThrough, Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"

export type ResearchArtifactSink = {
  writable: PassThrough | ReturnType<typeof createWriteStream>
  done: Promise<void>
}

export type ResearchArtifact = {
  stream: ReadableStream<Uint8Array>
  contentLength: number | null
}

export interface ResearchExportStorage {
  create(key: string, contentType: string): Promise<ResearchArtifactSink>
  open(key: string): Promise<ResearchArtifact>
  remove(key: string): Promise<void>
}

function safeLocalPath(root: string, key: string): string {
  const target = resolve(root, ...key.split("/").filter(Boolean))
  const normalizedRoot = resolve(root)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("INVALID_EXPORT_ARTIFACT_KEY")
  }
  return target
}

class FileResearchExportStorage implements ResearchExportStorage {
  constructor(private readonly root: string) {}

  async create(key: string): Promise<ResearchArtifactSink> {
    const target = safeLocalPath(this.root, key)
    await mkdir(dirname(target), { recursive: true })
    const writable = createWriteStream(target, { flags: "wx" })
    return { writable, done: finished(writable) }
  }

  async open(key: string): Promise<ResearchArtifact> {
    const target = safeLocalPath(this.root, key)
    const details = await stat(target)
    const readable = createReadStream(target)
    return {
      stream: Readable.toWeb(readable) as ReadableStream<Uint8Array>,
      contentLength: details.size,
    }
  }

  async remove(key: string): Promise<void> {
    await rm(safeLocalPath(this.root, key), { force: true })
  }
}

class S3ResearchExportStorage implements ResearchExportStorage {
  private readonly client: S3Client

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
  ) {
    const endpoint = process.env.RESEARCH_EXPORT_S3_ENDPOINT
    this.client = new S3Client({
      region: process.env.RESEARCH_EXPORT_S3_REGION ?? "auto",
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: process.env.RESEARCH_EXPORT_S3_FORCE_PATH_STYLE === "true",
      ...(process.env.RESEARCH_EXPORT_S3_ACCESS_KEY_ID && process.env.RESEARCH_EXPORT_S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.RESEARCH_EXPORT_S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.RESEARCH_EXPORT_S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    })
  }

  private key(key: string): string {
    return [this.prefix.replace(/^\/+|\/+$/g, ""), key].filter(Boolean).join("/")
  }

  async create(key: string, contentType: string): Promise<ResearchArtifactSink> {
    const writable = new PassThrough()
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.key(key),
        Body: writable,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
        IfNoneMatch: "*",
      },
    })
    return { writable, done: upload.done().then(() => undefined) }
  }

  async open(key: string): Promise<ResearchArtifact> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key(key),
    }))
    if (!result.Body) throw new Error("EXPORT_ARTIFACT_MISSING")
    return {
      stream: result.Body.transformToWebStream() as ReadableStream<Uint8Array>,
      contentLength: result.ContentLength ?? null,
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.key(key),
    }))
  }
}

let cached: ResearchExportStorage | undefined

export function researchExportStorage(): ResearchExportStorage {
  if (cached) return cached
  const driver = process.env.RESEARCH_EXPORT_STORAGE_DRIVER ?? "filesystem"
  if (driver === "s3") {
    const bucket = process.env.RESEARCH_EXPORT_S3_BUCKET
    if (!bucket) throw new Error("RESEARCH_EXPORT_S3_BUCKET is required")
    cached = new S3ResearchExportStorage(
      bucket,
      process.env.RESEARCH_EXPORT_S3_PREFIX ?? "research-exports",
    )
    return cached
  }
  if (driver !== "filesystem") throw new Error("Unsupported research export storage driver")
  if (process.env.VERCEL) {
    throw new Error("Filesystem research export storage is disabled on Vercel")
  }
  cached = new FileResearchExportStorage(
    process.env.RESEARCH_EXPORT_STORAGE_DIR ?? resolve(process.cwd(), ".data", "research-exports"),
  )
  return cached
}

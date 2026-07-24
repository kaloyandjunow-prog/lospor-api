import sharp from "sharp"
import * as fs from "fs"

async function main() {
  const before = fs.statSync("public/logo.png").size
  await sharp("public/logo.png")
    .resize(400, null, { withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile("public/logo.webp")
  const after = fs.statSync("public/logo.webp").size
  console.log(`PNG: ${Math.round(before / 1024)}KB → WebP: ${Math.round(after / 1024)}KB (${Math.round((1 - after / before) * 100)}% smaller)`)
}
main().catch(console.error)

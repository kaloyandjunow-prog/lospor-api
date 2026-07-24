import "server-only"
import { existsSync } from "node:fs"

// Renders a page of this app in headless Chrome and returns it as a PDF.
// Dev / self-hosted: uses the machine's installed Chrome or Edge (no browser
// download). Vercel / Lambda: uses the @sparticuz/chromium serverless build.

const WIN_CANDIDATES = [
  process.env.PROGRAMFILES ? `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe` : "",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : "",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
]
const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]
const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
]

function localChromePath(): string | null {
  const explicit = process.env.CHROME_EXECUTABLE_PATH
  if (explicit && existsSync(/* turbopackIgnore: true */ explicit)) return explicit
  const candidates =
    process.platform === "win32" ? WIN_CANDIDATES
    : process.platform === "darwin" ? MAC_CANDIDATES
    : LINUX_CANDIDATES
  for (const p of candidates) if (p && existsSync(/* turbopackIgnore: true */ p)) return p
  return null
}

async function launchBrowser() {
  const puppeteer = await import("puppeteer-core")
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = (await import("@sparticuz/chromium")).default
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }
  const exe = localChromePath()
  if (!exe) throw new Error("No local Chrome/Edge found — set CHROME_EXECUTABLE_PATH")
  return puppeteer.launch({ executablePath: exe, headless: true })
}

// url must be a full absolute URL to /cases/[id]/print with a valid print_token.
// lang ("bg") localizes the record — the print page reads the locale cookie.
export async function renderRecordPdf(url: string, lang?: string): Promise<Uint8Array> {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    if (lang) await page.setCookie({ name: "locale", value: lang, url })
    // Desktop-sized viewport so the page renders its normal (approved) layout.
    await page.setViewport({ width: 1280, height: 900 })
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 })
    // Wait for the timetable SVG to be built; print whatever rendered on timeout.
    await page
      .waitForFunction(
        () => {
          const svg = document.querySelector(".timetable-svg")
          return !!svg && svg.childNodes.length > 5
        },
        { timeout: 20_000 },
      )
      .catch(() => {})
    await new Promise(r => setTimeout(r, 400))
    return await page.pdf({
      format: "a4",
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    })
  } finally {
    await browser.close()
  }
}

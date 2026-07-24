import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "../src/data/drugs.json");
const BASE = "https://www.bda.bg/images/stories/documents/register/drugs/";
const CONCURRENCY = 8;

const LETTER_PAGES = [
  "t40.htm","t53.htm","t65.htm","t66.htm","t67.htm","t68.htm","t69.htm",
  "t70.htm","t71.htm","t72.htm","t73.htm","t74.htm","t75.htm","t76.htm",
  "t77.htm","t78.htm","t79.htm","t80.htm","t81.htm","t82.htm","t83.htm",
  "t84.htm","t85.htm","t86.htm","t87.htm","t88.htm","t89.htm","t90.htm",
  "t102.htm","t109.htm","t110.htm","t111.htm","t193.htm",
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "Accept-Encoding": "identity" } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function fetchText(url) {
  try {
    const buf = await get(url);
    return new TextDecoder("windows-1251").decode(buf);
  } catch {
    return "";
  }
}

function parseDrugPage(html) {
  // Strip tags → lines
  const lines = html
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  function after(label) {
    const idx = lines.indexOf(label);
    if (idx < 0) return "";
    for (let i = idx + 1; i < Math.min(idx + 6, lines.length); i++) {
      const v = lines[i];
      if (v !== "." && !/^\d+$/.test(v) && v !== "-") return v;
    }
    return "";
  }

  const nameIdx = lines.indexOf("Търговско име:");
  const name = nameIdx >= 0 ? lines[nameIdx + 1] ?? "" : "";

  // Strength+form line: comes after name, often has digits or form keywords
  let strengthForm = "";
  for (let i = nameIdx + 2; i < Math.min(nameIdx + 8, lines.length); i++) {
    const l = lines[i];
    if (/\d/.test(l) || /mg|ml|mcg|tablet|capsule|solution|injection|patch|cream|gel|powder|syrup|drop/i.test(l)) {
      strengthForm = l;
      break;
    }
  }

  // Keep only English part (before Cyrillic)
  let englishPart = strengthForm;
  for (let i = 0; i < strengthForm.length; i++) {
    if (/[Ѐ-ӿ]/.test(strengthForm[i])) {
      englishPart = strengthForm.substring(0, i).trim();
      break;
    }
  }

  // Derive form by stripping leading dose
  const doseMatch = englishPart.match(
    /^[\d.,/]+\s*(?:mg\/ml|mcg\/ml|mg|ml|mcg|µg|g|IU|MBq|GBq|%)(?:\/[\d.,]+\s*ml)?\s+(.*)/i
  );
  const form = doseMatch ? doseMatch[1].trim() : englishPart;

  const inn = after("Межд.непат.име:");

  // ATC: find line matching ATC pattern after label
  const atcIdx = lines.indexOf("ATC кодове:");
  let atc = "";
  if (atcIdx >= 0) {
    for (let i = atcIdx + 1; i < Math.min(atcIdx + 8, lines.length); i++) {
      if (/^[A-Z]\d{2}[A-Z]{2}/.test(lines[i])) { atc = lines[i]; break; }
    }
  }

  return {
    name:     name.trim(),
    inn:      inn.trim(),
    form:     form.trim(),
    strength: (englishPart || name).trim(),
    atc:      atc.trim(),
  };
}

async function pool(tasks, concurrency, fn) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await fn(tasks[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

(async () => {
  console.log("Step 1: Collecting all drug IDs from letter pages…");
  const allIds = [];
  for (const page of LETTER_PAGES) {
    const html = await fetchText(BASE + page);
    const ids = [...html.matchAll(/href="details\/lf(\d+)\.htm"/g)].map(m => m[1]);
    allIds.push(...ids);
    process.stdout.write(`  ${page} → ${ids.length} drugs\n`);
  }
  const uniqueIds = [...new Set(allIds)];
  console.log(`\nTotal unique drug presentations: ${uniqueIds.length}`);

  console.log("\nStep 2: Fetching detail pages…");
  let done = 0;
  const drugs = await pool(uniqueIds, CONCURRENCY, async (id) => {
    const html = await fetchText(`${BASE}details/lf${id}d.htm`);
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${uniqueIds.length}…`);
    if (!html) return null;
    const drug = parseDrugPage(html);
    drug._id = id;
    return drug;
  });

  const valid = drugs
    .filter(d => d && d.name)
    .map(({ _id, ...d }) => d);

  // Deduplicate by name (case-insensitive)
  const seen = new Set();
  const deduped = valid.filter(d => {
    const key = d.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nParsed: ${valid.length}  After dedup: ${deduped.length}`);
  fs.writeFileSync(OUT, JSON.stringify(deduped, null, 2), { encoding: "utf8" });
  console.log(`Written to ${OUT}`);
})();

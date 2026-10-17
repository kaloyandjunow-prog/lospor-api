import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { localizeServerMessage, SERVER_MESSAGES_BG } from "@lospor/core/server-messages"

const SOURCE = join(import.meta.dirname, "..")

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === "generated" || entry.name === "__tests__" ? [] : sourceFiles(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
  })
}

/** Every `error: "..."` the API can send, with where it is written. */
function errorMessages() {
  const found: { text: string; template: boolean; where: string }[] = []
  for (const file of sourceFiles(SOURCE)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText() === "error") {
        const value = node.initializer
        const where = `${relative(SOURCE, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) found.push({ text: value.text, template: false, where })
        else if (ts.isTemplateExpression(value)) found.push({ text: value.getText(), template: true, where })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found.filter(message => /[A-Za-z]{3}/.test(message.text))
}

describe("the API's error messages in Bulgarian", () => {
  it("has a Bulgarian version of every message the API sends", () => {
    const messages = errorMessages()
    expect(messages.length).toBeGreaterThan(100)
    const untranslated = messages
      .filter(message => !message.template && !SERVER_MESSAGES_BG[message.text])
      .map(message => `${message.where}  ${message.text}`)
    expect(untranslated, "add these to SERVER_MESSAGES_BG in @lospor/core/server-messages").toEqual([])
  })

  it("translates every message built from a template", () => {
    const samples: Record<string, string> = {
      "`Export contains ${matchingCount} matching cases; narrow the export before retrying`": "Export contains 7 matching cases; narrow the export before retrying",
      "`Invalid ${name} revision`": "Invalid preop revision",
      "`Invalid ${name} conflict timestamp`": "Invalid postop conflict timestamp",
      "`${piiError.message} Please remove identifying information before saving.`": "Looks like a name. Please remove identifying information before saving.",
    }
    for (const message of errorMessages().filter(item => item.template)) {
      const sample = samples[message.text]
      expect(sample, `add a sample for ${message.where}`).toBeDefined()
      expect(localizeServerMessage(sample!, "bg"), message.where).not.toBe(sample)
    }
  })
})

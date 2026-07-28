#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const goldenRoot = path.join(repoRoot, "shared/domain/fixtures/convex-wire-golden")
const provenancePath = path.join(repoRoot, "shared/domain/convex-wire-golden-provenance.json")
const provenance = JSON.parse(await readFile(provenancePath, "utf8"))
const failures = []

const queryShapeAlgorithm = "typescript-token-query-dependency-closure-v1"
const queryShapeSources = ["convex/schema.ts", "convex/tables.ts"]

function tokenizeTypeScript(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2)
      if (index === -1) break
      continue
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2)
      if (end === -1) throw new Error("unterminated block comment")
      index = end + 2
      continue
    }
    if (char === "'" || char === "\"" || char === "`") {
      const quote = char
      const start = index
      index += 1
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2
          continue
        }
        if (source[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      if (source[index - 1] !== quote) {
        throw new Error(`unterminated ${quote} literal`)
      }
      const raw = source.slice(start, index)
      const value = quote === "\"" ? JSON.parse(raw) : raw.slice(1, -1)
      tokens.push({ type: quote === "`" ? "template" : "string", value, raw })
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index
      index += 1
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
        index += 1
      }
      const value = source.slice(start, index)
      tokens.push({ type: "identifier", value, raw: value })
      continue
    }
    if (/[0-9]/.test(char)) {
      const start = index
      index += 1
      while (index < source.length && /[0-9A-Fa-f_xXobn.eE+-]/.test(source[index])) {
        index += 1
      }
      const value = source.slice(start, index)
      tokens.push({ type: "number", value, raw: value })
      continue
    }
    tokens.push({ type: "punctuation", value: char, raw: char })
    index += 1
  }
  return tokens
}

function matchingToken(tokens, start, open, close) {
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1
    if (tokens[index].value === close) depth -= 1
    if (depth === 0) return index
  }
  throw new Error(`unmatched ${open}`)
}

function declarationEnd(tokens, start, keywordIndex, keyword) {
  let braces = 0
  let parentheses = 0
  let brackets = 0
  let bodyStarted = false
  const blockDeclaration = ["function", "class", "interface", "enum"].includes(keyword)
  for (let index = keywordIndex + 1; index < tokens.length; index += 1) {
    const value = tokens[index].value
    if (value === "(") parentheses += 1
    else if (value === ")") parentheses -= 1
    else if (value === "[") brackets += 1
    else if (value === "]") brackets -= 1
    else if (value === "{") {
      if (parentheses === 0 && brackets === 0) bodyStarted = true
      braces += 1
    } else if (value === "}") {
      braces -= 1
      if (blockDeclaration && bodyStarted && braces === 0 && parentheses === 0) {
        return tokens[index + 1]?.value === ";" ? index + 2 : index + 1
      }
    } else if (
      value === ";"
      && braces === 0
      && parentheses === 0
      && brackets === 0
      && !blockDeclaration
    ) {
      return index + 1
    }
  }
  throw new Error(`unterminated top-level ${tokens[start].value} declaration`)
}

function topLevelDeclarations(tokens, source) {
  const declarations = new Map()
  let braces = 0
  let parentheses = 0
  let brackets = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value
    if (braces === 0 && parentheses === 0 && brackets === 0) {
      const start = index
      let keywordIndex = index
      while (
        ["export", "default", "declare", "async"].includes(tokens[keywordIndex]?.value)
      ) {
        keywordIndex += 1
      }
      const keyword = tokens[keywordIndex]?.value
      if (["const", "let", "var", "function", "type", "interface", "enum", "class"].includes(keyword)) {
        let nameIndex = keywordIndex + 1
        if (tokens[nameIndex]?.value === "*") nameIndex += 1
        const name = tokens[nameIndex]?.type === "identifier"
          ? tokens[nameIndex].value
          : undefined
        if (name) {
          const end = declarationEnd(tokens, start, keywordIndex, keyword)
          declarations.set(name, {
            name,
            source,
            tokens: tokens.slice(start, end),
          })
          index = end - 1
          continue
        }
      }
    }
    if (value === "{") braces += 1
    else if (value === "}") braces -= 1
    else if (value === "(") parentheses += 1
    else if (value === ")") parentheses -= 1
    else if (value === "[") brackets += 1
    else if (value === "]") brackets -= 1
  }
  return declarations
}

function schemaTableNames(tokens) {
  const defineSchemaIndex = tokens.findIndex(
    (token, index) => token.value === "defineSchema" && tokens[index + 1]?.value === "(",
  )
  if (defineSchemaIndex === -1) throw new Error("convex/schema.ts has no defineSchema call")
  const objectStart = tokens.findIndex(
    (token, index) => index > defineSchemaIndex && token.value === "{",
  )
  if (objectStart === -1) throw new Error("defineSchema has no object literal")
  const objectEnd = matchingToken(tokens, objectStart, "{", "}")
  const names = new Set()
  let depth = 1
  for (let index = objectStart + 1; index < objectEnd; index += 1) {
    const value = tokens[index].value
    if (value === "{") depth += 1
    else if (value === "}") depth -= 1
    else if (
      depth === 1
      && (tokens[index].type === "identifier" || tokens[index].type === "string")
      && tokens[index + 1]?.value === ":"
    ) {
      names.add(tokens[index].value)
    }
  }
  return names
}

function canonicalTokens(tokens) {
  return tokens
    .map((token) => `${token.type}:${token.raw}`)
    .join("\u001f")
}

async function queryShapeDigests(root, queryNames) {
  const sources = Object.fromEntries(
    await Promise.all(
      queryShapeSources.map(async (relativePath) => [
        relativePath,
        tokenizeTypeScript(await readFile(path.join(root, relativePath), "utf8")),
      ]),
    ),
  )
  const tableDeclarations = topLevelDeclarations(
    sources["convex/tables.ts"],
    "convex/tables.ts",
  )
  const schemaDeclarations = topLevelDeclarations(
    sources["convex/schema.ts"],
    "convex/schema.ts",
  )
  const declarationsByName = new Map()
  for (const declaration of [
    ...tableDeclarations.values(),
    ...schemaDeclarations.values(),
  ]) {
    const declarations = declarationsByName.get(declaration.name) ?? []
    declarations.push(declaration)
    declarationsByName.set(declaration.name, declarations)
  }
  const tableNames = schemaTableNames(sources["convex/schema.ts"])
  const digests = {}

  for (const queryName of queryNames) {
    const rootDeclaration = tableDeclarations.get(queryName)
    if (!rootDeclaration) {
      throw new Error(`captured query ${queryName} is not exported by convex/tables.ts`)
    }
    const selected = new Map()
    const queue = []
    const referencedTables = new Set()
    const enqueue = (declaration) => {
      const key = `${declaration.source}:declaration:${declaration.name}`
      if (selected.has(key)) return
      selected.set(key, declaration)
      queue.push(declaration)
    }
    enqueue(rootDeclaration)

    for (let index = 0; index < queue.length; index += 1) {
      const declaration = queue[index]
      for (let tokenIndex = 0; tokenIndex < declaration.tokens.length; tokenIndex += 1) {
        const token = declaration.tokens[tokenIndex]
        if (
          token.value === "."
          && declaration.tokens[tokenIndex + 1]?.value === "query"
          && declaration.tokens[tokenIndex + 2]?.value === "("
          && declaration.tokens[tokenIndex + 3]?.type === "string"
        ) {
          const tableName = declaration.tokens[tokenIndex + 3].value
          referencedTables.add(tableName)
          if (!tableNames.has(tableName)) {
            throw new Error(
              `captured query ${queryName} reads unknown schema table ${tableName}`,
            )
          }
        }
        const isPropertyName = (
          declaration.tokens[tokenIndex - 1]?.value === "."
          || declaration.tokens[tokenIndex + 1]?.value === ":"
        )
        if (token.type === "identifier" && !isPropertyName) {
          for (const dependency of declarationsByName.get(token.value) ?? []) {
            enqueue(dependency)
          }
        }
      }
    }

    if (referencedTables.size === 0) {
      throw new Error(`captured query ${queryName} does not read a schema table`)
    }
    const canonical = [...selected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, declaration]) => `${key}\n${canonicalTokens(declaration.tokens)}`)
      .join("\n\n")
    digests[queryName] = createHash("sha256").update(canonical).digest("hex")
  }
  return digests
}

if (provenance.version !== 2) {
  failures.push(`unsupported provenance version ${String(provenance.version)}`)
}

const formats = provenance.attestation?.formats
const queries = provenance.attestation?.queries
if (
  !Array.isArray(formats)
  || formats.join(",") !== "json,convex_encoded_json"
  || !Array.isArray(queries)
  || queries.length === 0
) {
  failures.push("attestation must name both wire formats and at least one query")
}

const expectedFiles = new Set()
for (const query of queries ?? []) {
  for (const format of formats ?? []) {
    expectedFiles.add(`${query}.${format}.json`)
  }
}

const captureFiles = (await readdir(goldenRoot))
  .filter((name) => name.endsWith(".json"))
  .sort()
const attestedFiles = Object.keys(provenance.captures ?? {}).sort()

for (const filename of expectedFiles) {
  if (!captureFiles.includes(filename)) {
    failures.push(`missing capture ${filename}`)
  }
}
for (const filename of captureFiles) {
  if (!expectedFiles.has(filename)) {
    failures.push(`capture is not named by the attestation: ${filename}`)
  }
}
if (captureFiles.join("\n") !== attestedFiles.join("\n")) {
  failures.push("capture files and provenance checksum entries differ")
}

for (const filename of captureFiles) {
  const bytes = await readFile(path.join(goldenRoot, filename))
  const actual = createHash("sha256").update(bytes).digest("hex")
  const expected = provenance.captures?.[filename]
  if (actual !== expected) {
    failures.push(
      `checksum mismatch for ${filename}: expected ${String(expected)}, received ${actual}`,
    )
  }
}

const queryShapes = provenance.queryShapes
if (queryShapes?.algorithm !== queryShapeAlgorithm) {
  failures.push(`queryShapes.algorithm must be ${queryShapeAlgorithm}`)
}
if (
  !Array.isArray(queryShapes?.sources)
  || queryShapes.sources.join(",") !== queryShapeSources.join(",")
) {
  failures.push(`queryShapes.sources must be ${queryShapeSources.join(", ")}`)
}

const shapeQueries = (
  queryShapes?.sha256 !== null
  && typeof queryShapes?.sha256 === "object"
  && !Array.isArray(queryShapes.sha256)
)
  ? Object.keys(queryShapes.sha256).sort()
  : []
for (const query of queries ?? []) {
  if (!shapeQueries.includes(query)) {
    failures.push(`captured query is missing a query shape checksum: ${query}`)
  }
}

let actualQueryShapeDigests = {}
try {
  actualQueryShapeDigests = await queryShapeDigests(repoRoot, shapeQueries)
  for (const query of shapeQueries) {
    const expected = queryShapes?.sha256?.[query]
    const actual = actualQueryShapeDigests[query]
    if (actual !== expected) {
      failures.push(
        `query shape checksum mismatch for ${query}: `
          + `expected ${String(expected)}, received ${actual}`,
      )
    }
  }
} catch (error) {
  failures.push(`could not compute query shape checksums: ${error.message}`)
}

if (process.argv.includes("--print-query-shapes")) {
  console.log(JSON.stringify(actualQueryShapeDigests, null, 2))
  process.exit(Object.keys(actualQueryShapeDigests).length === 0 ? 1 : 0)
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`)
  }
  process.exit(1)
}

const capturedDate = provenance.capturedDate
if (typeof capturedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(capturedDate)) {
  console.error("FAIL: capturedDate must be an ISO calendar date (YYYY-MM-DD)")
  process.exit(1)
}

const capturedAt = new Date(`${capturedDate}T00:00:00.000Z`)
const nowInput = process.env.CONVEX_WIRE_GOLDEN_NOW
const now = nowInput === undefined ? new Date() : new Date(nowInput)
if (Number.isNaN(capturedAt.valueOf()) || Number.isNaN(now.valueOf())) {
  console.error("FAIL: capturedDate or CONVEX_WIRE_GOLDEN_NOW is not a valid date")
  process.exit(1)
}

const ageDays = Math.floor((now.valueOf() - capturedAt.valueOf()) / 86_400_000)
const warningAfterDays = provenance.freshness?.warningAfterDays
const failAfterDays = provenance.freshness?.failAfterDays
if (
  !Number.isInteger(warningAfterDays)
  || !Number.isInteger(failAfterDays)
  || warningAfterDays < 1
  || failAfterDays <= warningAfterDays
) {
  console.error("FAIL: freshness thresholds must be increasing positive integers")
  process.exit(1)
}
if (ageDays < 0) {
  console.error(`FAIL: capture date ${capturedDate} is ${Math.abs(ageDays)} days in the future`)
  process.exit(1)
}
if (ageDays >= failAfterDays) {
  console.error(
    `::error::Production wire goldens are ${ageDays} days old (captured ${capturedDate}); `
      + `the ${failAfterDays}-day freshness limit requires a new attested production capture.`,
  )
  process.exit(1)
}
if (ageDays >= warningAfterDays) {
  console.warn(
    `::warning::Production wire goldens are ${ageDays} days old (captured ${capturedDate}); `
      + `refresh before the ${failAfterDays}-day hard limit.`,
  )
}

console.log(
  `PASS: ${captureFiles.length} production wire captures match their provenance checksums `
    + `and ${Object.keys(actualQueryShapeDigests).length} attested query shapes; `
    + `age ${ageDays} days.`,
)

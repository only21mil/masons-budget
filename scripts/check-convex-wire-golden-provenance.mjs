#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const goldenRoot = path.join(repoRoot, "shared/domain/fixtures/convex-wire-golden")
const provenancePath = path.join(repoRoot, "shared/domain/convex-wire-golden-provenance.json")
const provenance = JSON.parse(await readFile(provenancePath, "utf8"))
const failures = []

const queryShapeAlgorithm = "typescript-ast-query-dependency-closure-v1"
const queryShapeSources = ["convex/schema.ts", "convex/tables.ts"]

function topLevelDeclarations(sourceFile) {
  const declarations = new Map()
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, statement)
        }
      }
    } else if (
      (ts.isFunctionDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isClassDeclaration(statement))
      && statement.name
    ) {
      declarations.set(statement.name.text, statement)
    }
  }
  return declarations
}

function schemaTables(sourceFile) {
  const tables = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || !ts.isCallExpression(statement.expression)) {
      continue
    }
    const [schemaObject] = statement.expression.arguments
    if (!schemaObject || !ts.isObjectLiteralExpression(schemaObject)) continue
    for (const property of schemaObject.properties) {
      if (
        (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))
        && property.name
      ) {
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined
        if (name !== undefined) tables.set(name, property)
      }
    }
  }
  return tables
}

function canonicalTopLevelDeclaration(declaration, allowedSources) {
  const sourceFile = declaration.getSourceFile()
  if (!allowedSources.has(sourceFile.fileName)) return null

  let current = declaration
  while (current.parent && current.parent !== sourceFile) {
    current = current.parent
  }
  if (current.parent !== sourceFile || ts.isImportDeclaration(current)) return null
  if (
    ts.isVariableStatement(current)
    || ts.isFunctionDeclaration(current)
    || ts.isTypeAliasDeclaration(current)
    || ts.isInterfaceDeclaration(current)
    || ts.isEnumDeclaration(current)
    || ts.isClassDeclaration(current)
  ) {
    return current
  }
  return null
}

function declarationName(node) {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration) => ts.isIdentifier(declaration.name) ? declaration.name.text : "")
      .filter(Boolean)
      .join(",")
  }
  return node.name?.text ?? `node-${node.pos}`
}

function queryShapeDigests(root, queryNames) {
  const sourcePaths = Object.fromEntries(
    queryShapeSources.map((relativePath) => [
      relativePath,
      path.join(root, relativePath),
    ]),
  )
  const program = ts.createProgram(Object.values(sourcePaths), {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  })
  const checker = program.getTypeChecker()
  const schemaSource = program.getSourceFile(sourcePaths["convex/schema.ts"])
  const tablesSource = program.getSourceFile(sourcePaths["convex/tables.ts"])
  if (!schemaSource || !tablesSource) {
    throw new Error("query shape sources could not be parsed")
  }

  const allowedSources = new Set([schemaSource.fileName, tablesSource.fileName])
  const tablesDeclarations = topLevelDeclarations(tablesSource)
  const tableShapes = schemaTables(schemaSource)
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  })
  const relativeSource = (sourceFile) =>
    path.relative(root, sourceFile.fileName).split(path.sep).join("/")

  const digests = {}
  for (const queryName of queryNames) {
    const rootDeclaration = tablesDeclarations.get(queryName)
    if (!rootDeclaration) {
      throw new Error(`captured query ${queryName} is not exported by convex/tables.ts`)
    }

    const selected = new Map()
    const queue = []
    const referencedTables = new Set()
    const enqueue = (key, node, sourceFile = node.getSourceFile()) => {
      const stableKey = `${relativeSource(sourceFile)}:${key}`
      if (selected.has(stableKey)) return
      selected.set(stableKey, { node, sourceFile })
      queue.push({ node, sourceFile })
    }
    enqueue(`declaration:${declarationName(rootDeclaration)}`, rootDeclaration, tablesSource)

    for (let index = 0; index < queue.length; index += 1) {
      const { node } = queue[index]
      const visit = (child) => {
        if (
          ts.isCallExpression(child)
          && ts.isPropertyAccessExpression(child.expression)
          && child.expression.name.text === "query"
          && child.arguments.length > 0
          && ts.isStringLiteral(child.arguments[0])
        ) {
          const tableName = child.arguments[0].text
          referencedTables.add(tableName)
          if (!tableShapes.has(tableName)) {
            throw new Error(
              `captured query ${queryName} reads unknown schema table ${tableName}`,
            )
          }
        }

        if (ts.isIdentifier(child)) {
          let symbol = checker.getSymbolAtLocation(child)
          if (symbol?.flags & ts.SymbolFlags.Alias) {
            try {
              symbol = checker.getAliasedSymbol(symbol)
            } catch {
              symbol = undefined
            }
          }
          for (const declaration of symbol?.declarations ?? []) {
            const topLevel = canonicalTopLevelDeclaration(declaration, allowedSources)
            if (topLevel) {
              enqueue(
                `declaration:${declarationName(topLevel)}`,
                topLevel,
                topLevel.getSourceFile(),
              )
            }
          }
        }
        ts.forEachChild(child, visit)
      }
      ts.forEachChild(node, visit)
    }

    if (referencedTables.size === 0) {
      throw new Error(`captured query ${queryName} does not read a schema table`)
    }
    const canonical = [...selected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, { node, sourceFile }]) =>
        `${key}\n${printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)}`,
      )
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

let actualQueryShapeDigests = {}
try {
  actualQueryShapeDigests = queryShapeDigests(repoRoot, queries ?? [])
  for (const query of queries ?? []) {
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
    + `and ${Object.keys(actualQueryShapeDigests).length} captured query shapes; `
    + `age ${ageDays} days.`,
)

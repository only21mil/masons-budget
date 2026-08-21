import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

export const CAPTURE_ENDPOINT = "https://keen-elephant-452.convex.cloud/api/query"
export const CAPTURE_DEPLOYMENT = "prod:keen-elephant-452"
export const CAPTURE_FORMATS = Object.freeze(["json", "convex_encoded_json"])
export const QUERY_SHAPE_ALGORITHM = "typescript-token-query-dependency-closure-v1"
export const QUERY_SHAPE_SOURCES = Object.freeze([
  "convex/schema.ts",
  "convex/tables.ts",
])
export const CAPTURE_QUERIES = Object.freeze([
  { name: "getBudgetDocument", path: "tables:getBudgetDocument", args: {
    viewer: "victor",
    scope: "netWorth",
  } },
  { name: "listBtcAccounts", path: "tables:listBtcAccounts", args: {
    viewer: "victor",
    scope: "visible",
    limit: 3,
  } },
  { name: "listBtcBillPays", path: "tables:listBtcBillPays", args: {
    viewer: "victor",
    scope: "visible",
    limit: 3,
  } },
  { name: "listBtcBuys", path: "tables:listBtcBuys", args: {
    viewer: "victor",
    scope: "visible",
    limit: 3,
  } },
  { name: "listTodos", path: "tables:listTodos", args: {
    viewer: "victor",
    limit: 3,
  } },
  { name: "listTransactions", path: "tables:listTransactions", args: {
    viewer: "victor",
    limit: 3,
  } },
  { name: "rowCounts", path: "tables:rowCounts", args: {} },
])

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

export function queryShapeDigestsFromSources(
  { tablesSource, schemaSource },
  queryNames,
) {
  const sources = {
    "convex/tables.ts": tokenizeTypeScript(tablesSource),
    "convex/schema.ts": tokenizeTypeScript(schemaSource),
  }
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

export async function queryShapeDigests(repoRoot, queryNames) {
  const [tablesSource, schemaSource] = await Promise.all([
    readFile(path.join(repoRoot, "convex/tables.ts"), "utf8"),
    readFile(path.join(repoRoot, "convex/schema.ts"), "utf8"),
  ])
  return queryShapeDigestsFromSources({ tablesSource, schemaSource }, queryNames)
}

export function assertPayloadCredentialSafe(bytes, token, captureName) {
  let decoded
  try {
    decoded = JSON.parse(bytes.toString("utf8"))
  } catch {
    decoded = null
  }
  const containsCredential = (value) => {
    if (typeof value === "string") return value.includes(token)
    if (Array.isArray(value)) return value.some(containsCredential)
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).some(
        ([key, nested]) => key.includes(token) || containsCredential(nested),
      )
    }
    return false
  }
  if (bytes.includes(Buffer.from(token)) || containsCredential(decoded)) {
    throw new Error(`${captureName} contains the read credential; refusing to write captures`)
  }
  const text = bytes.toString("utf8")
  const credentialMarkers = [
    /\bCONVEX_(?:READ|SYNC)_TOKEN\b/i,
    /["']?(?:authorization|access[_-]?token|read[_-]?token|credential|secret)["']?\s*:/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  ]
  if (credentialMarkers.some((pattern) => pattern.test(text))) {
    throw new Error(`${captureName} contains credential-shaped data; refusing to write captures`)
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function responseBytes(response, captureName) {
  if (!response.ok) {
    throw new Error(`${captureName} failed with HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  let decoded
  try {
    decoded = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error(`${captureName} returned invalid JSON`)
  }
  if (
    typeof decoded !== "object"
    || decoded === null
    || decoded.status !== "success"
  ) {
    throw new Error(`${captureName} did not return a successful Convex response`)
  }
  return bytes
}

async function atomicWriteSet(entries) {
  const staged = []
  try {
    for (const [target, bytes] of entries) {
      await mkdir(path.dirname(target), { recursive: true })
      const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
      )
      await writeFile(temporary, bytes, { flag: "wx" })
      staged.push([temporary, target])
    }
    for (const [temporary, target] of staged) {
      await rename(temporary, target)
    }
  } catch (error) {
    await Promise.all(staged.map(async ([temporary]) => {
      try {
        await unlink(temporary)
      } catch {
        // A completed rename or concurrent cleanup is already safe.
      }
    }))
    throw error
  }
}

export async function captureWireGoldens({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  repoRoot,
} = {}) {
  const token = env.CONVEX_READ_TOKEN
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("CONVEX_READ_TOKEN must be set in the environment")
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable")
  if (typeof repoRoot !== "string") throw new Error("repoRoot is required")

  const previousProvenancePath = path.join(
    repoRoot,
    "shared/domain/convex-wire-golden-provenance.json",
  )
  let previousProvenance = {}
  try {
    previousProvenance = JSON.parse(await readFile(previousProvenancePath, "utf8"))
  } catch {
    // A first capture has no additional attested queries or prior freshness policy.
  }
  const previouslyAttestedQueries = (
    previousProvenance.queryShapes?.sha256 !== null
    && typeof previousProvenance.queryShapes?.sha256 === "object"
    && !Array.isArray(previousProvenance.queryShapes.sha256)
  )
    ? Object.keys(previousProvenance.queryShapes.sha256)
    : []
  const queryNames = [
    ...new Set([
      ...CAPTURE_QUERIES.map(({ name }) => name),
      ...previouslyAttestedQueries,
    ]),
  ].sort()
  const queryShapes = await queryShapeDigests(repoRoot, queryNames)

  const captures = new Map()
  for (const query of CAPTURE_QUERIES) {
    for (const format of CAPTURE_FORMATS) {
      const filename = `${query.name}.${format}.json`
      let response
      try {
        response = await fetchImpl(CAPTURE_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: query.path,
            args: { ...query.args, token },
            format,
          }),
        })
      } catch {
        throw new Error(`${filename} request failed`)
      }
      const bytes = await responseBytes(response, filename)
      assertPayloadCredentialSafe(bytes, token, filename)
      captures.set(filename, bytes)
    }
  }

  const freshness = previousProvenance.freshness
    ?? { warningAfterDays: 30, failAfterDays: 60 }

  const provenance = {
    version: 2,
    capturedDate: now.toISOString().slice(0, 10),
    capturedDatePrecision: "day",
    deployment: CAPTURE_DEPLOYMENT,
    endpoint: CAPTURE_ENDPOINT,
    attestation: {
      method: "authenticated production HTTP capture",
      credentialEchoChecked: true,
      formats: [...CAPTURE_FORMATS],
      queries: CAPTURE_QUERIES.map(({ name }) => name),
    },
    queryShapes: {
      algorithm: QUERY_SHAPE_ALGORITHM,
      sources: [...QUERY_SHAPE_SOURCES],
      sha256: queryShapes,
      reattestedNote:
        "Generated alongside this authenticated production capture using comment-free "
        + "per-query TypeScript token dependency closures. Previously attested queries "
        + "without wire captures are retained and refreshed.",
    },
    freshness,
    captures: Object.fromEntries(
      [...captures].sort(([left], [right]) => left.localeCompare(right))
        .map(([filename, bytes]) => [filename, sha256(bytes)]),
    ),
  }
  const goldenRoot = path.join(repoRoot, "shared/domain/fixtures/convex-wire-golden")
  const captureEntries = [...captures].map(([filename, bytes]) => [
    path.join(goldenRoot, filename),
    bytes,
  ])
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`)
  assertPayloadCredentialSafe(provenanceBytes, token, "provenance")
  await atomicWriteSet([
    ...captureEntries,
    [previousProvenancePath, provenanceBytes],
  ])
  return {
    captureCount: captures.size,
    queryShapeCount: Object.keys(queryShapes).length,
  }
}

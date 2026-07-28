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

const CONTRACT_SOURCES = Object.freeze([
  {
    path: "convex/tables.ts",
    declarations: [
      ["variable", "PUBLIC_SNAPSHOT_HARD_MAX"],
      ["function", "requestedRowCap"],
      ["function", "publicEnvelope"],
      ["function", "projectTransaction"],
      ["function", "projectTodo"],
      ["function", "projectBtcBuy"],
      ["function", "projectBtcBillPay"],
      ["function", "projectBtcAccount"],
      ["function", "publicBudgetDocument"],
      ["function", "budgetSourceFor"],
      ["variable", "scopeValidator"],
      ["variable", "listTransactions"],
      ["variable", "listTodos"],
      ["variable", "listBtcBuys"],
      ["variable", "listBtcBillPays"],
      ["variable", "listBtcAccounts"],
      ["variable", "getBudgetDocument"],
      ["variable", "rowCounts"],
    ],
  },
  {
    path: "convex/schema.ts",
    declarations: [
      ["variable", "familyMemberValidator"],
      ["variable", "custodyValidator"],
      ["variable", "budgetCategoryValidator"],
      ["variable", "budgetIncomeValidator"],
      ["variable", "monthlyHistoryValidator"],
      ["schemaTable", "transactions"],
      ["schemaTable", "todos"],
      ["schemaTable", "btcBuys"],
      ["schemaTable", "btcBillPays"],
      ["schemaTable", "btcAccounts"],
      ["schemaTable", "budgetDocuments"],
    ],
  },
])

function scannerState() {
  return {
    quote: null,
    escaped: false,
    lineComment: false,
    blockComment: false,
  }
}

function consumeLexicalCharacter(source, index, state) {
  const character = source[index]
  const next = source[index + 1]

  if (state.lineComment) {
    if (character === "\n") state.lineComment = false
    return true
  }
  if (state.blockComment) {
    if (character === "*" && next === "/") {
      state.blockComment = false
      return 2
    }
    return true
  }
  if (state.quote !== null) {
    if (state.escaped) {
      state.escaped = false
    } else if (character === "\\") {
      state.escaped = true
    } else if (character === state.quote) {
      state.quote = null
    }
    return true
  }
  if (character === "/" && next === "/") {
    state.lineComment = true
    return 2
  }
  if (character === "/" && next === "*") {
    state.blockComment = true
    return 2
  }
  if (character === "'" || character === "\"" || character === "`") {
    state.quote = character
    return true
  }
  return false
}

function findBalancedEnd(source, start, opening, closing) {
  const state = scannerState()
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const consumed = consumeLexicalCharacter(source, index, state)
    if (consumed === 2) {
      index += 1
      continue
    }
    if (consumed) continue
    if (source[index] === opening) depth += 1
    if (source[index] === closing) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  throw new Error(`capture contract declaration at offset ${start} is not balanced`)
}

function findExpressionEnd(source, start) {
  const state = scannerState()
  const depths = { "(": 0, "[": 0, "{": 0 }
  const closing = { ")": "(", "]": "[", "}": "{" }
  for (let index = start; index < source.length; index += 1) {
    const consumed = consumeLexicalCharacter(source, index, state)
    if (consumed === 2) {
      index += 1
      continue
    }
    if (consumed) continue
    const character = source[index]
    if (Object.hasOwn(depths, character)) depths[character] += 1
    if (Object.hasOwn(closing, character)) depths[closing[character]] -= 1
    const atTopLevel = Object.values(depths).every((depth) => depth === 0)
    if (atTopLevel && (character === ";" || character === ",")) return index
  }
  return source.length
}

function escapedName(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function extractDeclaration(source, kind, name) {
  const safeName = escapedName(name)
  if (kind === "function") {
    const match = new RegExp(
      `\\bfunction\\s+${safeName}(?:\\s*<[^>{}]*>)?\\s*\\(`,
    ).exec(source)
    if (match === null) throw new Error(`capture contract declaration missing: function ${name}`)
    const parametersStart = source.indexOf("(", match.index)
    const parametersEnd = findBalancedEnd(source, parametersStart, "(", ")")
    const bodyStart = source.indexOf("{", parametersEnd)
    if (bodyStart < 0) throw new Error(`capture contract function has no body: ${name}`)
    return source.slice(match.index, findBalancedEnd(source, bodyStart, "{", "}"))
  }

  const prefix = kind === "schemaTable"
    ? new RegExp(`\\b${safeName}\\s*:\\s*defineTable\\s*\\(`)
    : new RegExp(`\\b(?:export\\s+)?const\\s+${safeName}\\s*=`)
  const match = prefix.exec(source)
  if (match === null) throw new Error(`capture contract declaration missing: ${kind} ${name}`)
  const start = match.index
  const expressionStart = kind === "schemaTable"
    ? source.indexOf("defineTable", start)
    : source.indexOf("=", start) + 1
  return source.slice(start, findExpressionEnd(source, expressionStart)).trim()
}

function publicContractSources() {
  return CONTRACT_SOURCES.map((source) => ({
    path: source.path,
    declarations: source.declarations.map(([kind, name]) => ({ kind, name })),
  }))
}

export function captureContractDigestFromSources({ tablesSource, schemaSource }) {
  const sourceText = new Map([
    ["convex/tables.ts", tablesSource],
    ["convex/schema.ts", schemaSource],
  ])
  const units = []
  for (const source of CONTRACT_SOURCES) {
    const text = sourceText.get(source.path)
    if (typeof text !== "string") throw new Error(`missing contract source ${source.path}`)
    for (const [kind, name] of source.declarations) {
      units.push({
        path: source.path,
        kind,
        name,
        source: extractDeclaration(text, kind, name).replaceAll("\r\n", "\n"),
      })
    }
  }
  const canonical = JSON.stringify({
    version: 1,
    formats: CAPTURE_FORMATS,
    queries: CAPTURE_QUERIES,
    units,
  })
  return {
    sha256: createHash("sha256").update(canonical).digest("hex"),
    sources: publicContractSources(),
  }
}

export async function captureContractDigest(repoRoot) {
  const [tablesSource, schemaSource] = await Promise.all([
    readFile(path.join(repoRoot, "convex/tables.ts"), "utf8"),
    readFile(path.join(repoRoot, "convex/schema.ts"), "utf8"),
  ])
  return captureContractDigestFromSources({ tablesSource, schemaSource })
}

export function assertPayloadCredentialSafe(bytes, token, captureName) {
  if (bytes.includes(Buffer.from(token))) {
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

  const contract = await captureContractDigest(repoRoot)
  const previousProvenancePath = path.join(
    repoRoot,
    "shared/domain/convex-wire-golden-provenance.json",
  )
  let freshness = { warningAfterDays: 30, failAfterDays: 60 }
  try {
    const previous = JSON.parse(await readFile(previousProvenancePath, "utf8"))
    if (previous.freshness !== undefined) freshness = previous.freshness
  } catch {
    // A first capture uses the reviewed defaults above.
  }

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
    contract: {
      algorithm: "sha256",
      extractor: "selected-typescript-declarations-v1",
      sha256: contract.sha256,
      sources: contract.sources,
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
  return { captureCount: captures.size, contractSha256: contract.sha256 }
}

// Paired-device credential storage. MAIN PROCESS ONLY.
//
// Electron safeStorage is deliberately injected instead of imported here. That
// keeps every filesystem and failure branch executable in plain Node tests and,
// more importantly, makes the app-ready precondition explicit at the call site.

import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import type { VogelVaultMutationKind } from "../shared/ipc.ts"

const STORE_DIRECTORY = "paired-device"
const STORE_FILE = "credential.json"
const STORE_SCHEMA = 1
const MAX_STORE_BYTES = 16 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const BASE64_URL = /^[A-Za-z0-9_-]+$/
const MUTATION_KINDS = [
  "transaction.upsert",
  "transaction.delete",
  "todo.upsert",
  "todo.delete",
  "budgetCategory.upsert",
  "budgetCategory.delete",
  "btcBuy.upsert",
  "btcBuy.delete",
  "btcBillPay.upsert",
  "btcBillPay.delete",
  "btcAccount.upsert",
  "btcAccount.delete",
] as const satisfies readonly VogelVaultMutationKind[]
const MUTATION_KIND_SET: ReadonlySet<string> = new Set(MUTATION_KINDS)
const SAFE_LINUX_BACKENDS: ReadonlySet<string> = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
])

export type CredentialStorageReadiness =
  | "ready"
  | "app-not-ready"
  | "encryption-unavailable"
  | "unsafe-linux-backend"

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface DeviceCredentialSnapshot {
  readonly revision: string
  readonly deploymentOrigin: string
  readonly deviceId: string
  readonly deviceCredential: string
  readonly pairedAt: number
  readonly capabilities: readonly VogelVaultMutationKind[]
}

interface StoredCredentialEnvelope {
  readonly schemaVersion: 1
  readonly encryptedPayload: string
}

interface StoredCredentialPayload {
  readonly schemaVersion: 1
  readonly revision: string
  readonly deploymentOrigin: string
  readonly deviceId: string
  readonly deviceCredential: string
  readonly pairedAt: number
  readonly capabilities: readonly VogelVaultMutationKind[]
}

export class CredentialStorageError extends Error {
  constructor(readonly code: "unavailable" | "invalid" | "io") {
    super(code)
    this.name = "CredentialStorageError"
  }
}

export interface DeviceCredentialStore {
  readiness(): CredentialStorageReadiness
  load(): Promise<DeviceCredentialSnapshot | null>
  save(input: Omit<DeviceCredentialSnapshot, "revision">): Promise<DeviceCredentialSnapshot>
  clearIfCurrent(revision: string): Promise<boolean>
}

export interface DeviceCredentialStoreOptions {
  readonly appReady: () => boolean
  readonly platform: NodeJS.Platform
  readonly safeStorage: SafeStorageAdapter
  readonly userDataPath: string
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort()
  const wanted = [...expected].sort()
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function deploymentOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new CredentialStorageError("invalid")
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new CredentialStorageError("invalid")
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new CredentialStorageError("invalid")
  }
  return parsed.origin
}

function boundedBase64Url(value: unknown, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    !BASE64_URL.test(value)
  ) {
    throw new CredentialStorageError("invalid")
  }
  return value
}

function envelopeFromText(text: string): StoredCredentialEnvelope {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CredentialStorageError("invalid")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CredentialStorageError("invalid")
  }
  const record = value as Record<string, unknown>
  if (
    !exactKeys(record, [
      "schemaVersion",
      "encryptedPayload",
    ]) ||
    record["schemaVersion"] !== STORE_SCHEMA
  ) {
    throw new CredentialStorageError("invalid")
  }
  const encrypted = record["encryptedPayload"]
  if (
    typeof encrypted !== "string" ||
    encrypted.length === 0 ||
    encrypted.length > 12 * 1024 ||
    !BASE64.test(encrypted)
  ) {
    throw new CredentialStorageError("invalid")
  }
  return {
    schemaVersion: STORE_SCHEMA,
    encryptedPayload: encrypted,
  }
}

function payloadFromText(text: string): StoredCredentialPayload {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CredentialStorageError("invalid")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CredentialStorageError("invalid")
  }
  const record = value as Record<string, unknown>
  if (
    !exactKeys(record, [
      "schemaVersion",
      "revision",
      "deploymentOrigin",
      "deviceId",
      "deviceCredential",
      "pairedAt",
      "capabilities",
    ]) ||
    record["schemaVersion"] !== STORE_SCHEMA ||
    typeof record["pairedAt"] !== "number" ||
    !Number.isSafeInteger(record["pairedAt"]) ||
    record["pairedAt"] < 0
  ) {
    throw new CredentialStorageError("invalid")
  }
  return {
    schemaVersion: STORE_SCHEMA,
    revision: boundedBase64Url(record["revision"], 16, 128),
    deploymentOrigin: deploymentOrigin(record["deploymentOrigin"]),
    deviceId: boundedBase64Url(record["deviceId"], 16, 128),
    deviceCredential: boundedBase64Url(record["deviceCredential"], 32, 256),
    pairedAt: record["pairedAt"],
    capabilities: validatedCapabilities(record["capabilities"]),
  }
}

function validatedCapabilities(value: unknown): readonly VogelVaultMutationKind[] {
  if (
    !Array.isArray(value) ||
    value.length > MUTATION_KINDS.length ||
    value.some(
      (capability) =>
        typeof capability !== "string" ||
        !MUTATION_KIND_SET.has(capability),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new CredentialStorageError("invalid")
  }
  return value as VogelVaultMutationKind[]
}

async function privateRegularFile(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CredentialStorageError("invalid")
    if ((stat.mode & 0o077) !== 0) throw new CredentialStorageError("invalid")
    if (stat.size > MAX_STORE_BYTES) throw new CredentialStorageError("invalid")
    return true
  } catch (error) {
    if (error instanceof CredentialStorageError) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new CredentialStorageError("io")
  }
}

async function privateDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CredentialStorageError("invalid")
    }
    if ((stat.mode & 0o077) !== 0) throw new CredentialStorageError("invalid")
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new CredentialStorageError("invalid")
    }
    return true
  } catch (error) {
    if (error instanceof CredentialStorageError) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new CredentialStorageError("io")
  }
}

function revisionValue(): string {
  return randomUUID().replaceAll("-", "_")
}

export function createDeviceCredentialStore(
  options: DeviceCredentialStoreOptions,
): DeviceCredentialStore {
  const directory = path.join(options.userDataPath, STORE_DIRECTORY)
  const storePath = path.join(directory, STORE_FILE)
  let tail: Promise<void> = Promise.resolve()

  function readiness(): CredentialStorageReadiness {
    if (!options.appReady()) return "app-not-ready"
    try {
      if (!options.safeStorage.isEncryptionAvailable()) {
        return "encryption-unavailable"
      }
    } catch {
      return "encryption-unavailable"
    }
    if (options.platform === "linux") {
      try {
        const backend = options.safeStorage.getSelectedStorageBackend()
        if (!SAFE_LINUX_BACKENDS.has(backend)) {
          return "unsafe-linux-backend"
        }
      } catch {
        return "unsafe-linux-backend"
      }
    }
    return "ready"
  }

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function requireReady(): void {
    if (readiness() !== "ready") throw new CredentialStorageError("unavailable")
  }

  async function readEnvelope(): Promise<StoredCredentialEnvelope | null> {
    if (!(await privateDirectory(directory))) return null
    let handle
    try {
      handle = await open(
        storePath,
        fsConstants.O_RDONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new CredentialStorageError("invalid")
      }
      throw new CredentialStorageError("io")
    }
    try {
      const stat = await handle.stat()
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_STORE_BYTES ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        throw new CredentialStorageError("invalid")
      }
      const text = await handle.readFile({ encoding: "utf8" })
      if (Buffer.byteLength(text, "utf8") > MAX_STORE_BYTES) {
        throw new CredentialStorageError("invalid")
      }
      return envelopeFromText(text)
    } catch (error) {
      if (error instanceof CredentialStorageError) throw error
      throw new CredentialStorageError("io")
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  function decryptPayload(envelope: StoredCredentialEnvelope): StoredCredentialPayload {
    try {
      return payloadFromText(
        options.safeStorage.decryptString(
          Buffer.from(envelope.encryptedPayload, "base64"),
        ),
      )
    } catch (error) {
      if (error instanceof CredentialStorageError) throw error
      throw new CredentialStorageError("invalid")
    }
  }

  return {
    readiness,

    load(): Promise<DeviceCredentialSnapshot | null> {
      return exclusive(async () => {
        requireReady()
        const envelope = await readEnvelope()
        if (envelope === null) return null
        const payload = decryptPayload(envelope)
        return {
          revision: payload.revision,
          deploymentOrigin: payload.deploymentOrigin,
          deviceId: payload.deviceId,
          deviceCredential: payload.deviceCredential,
          pairedAt: payload.pairedAt,
          capabilities: payload.capabilities,
        }
      })
    },

    save(input: Omit<DeviceCredentialSnapshot, "revision">): Promise<DeviceCredentialSnapshot> {
      return exclusive(async () => {
        requireReady()
        const origin = deploymentOrigin(input.deploymentOrigin)
        const deviceId = boundedBase64Url(input.deviceId, 16, 128)
        const credential = boundedBase64Url(input.deviceCredential, 32, 256)
        const capabilities = validatedCapabilities(input.capabilities)
        if (!Number.isSafeInteger(input.pairedAt) || input.pairedAt < 0) {
          throw new CredentialStorageError("invalid")
        }

        const snapshot: DeviceCredentialSnapshot = {
          revision: revisionValue(),
          deploymentOrigin: origin,
          deviceId,
          deviceCredential: credential,
          pairedAt: input.pairedAt,
          capabilities,
        }
        const payload: StoredCredentialPayload = {
          schemaVersion: STORE_SCHEMA,
          ...snapshot,
        }
        let encrypted: Buffer
        try {
          encrypted = options.safeStorage.encryptString(JSON.stringify(payload))
        } catch {
          throw new CredentialStorageError("unavailable")
        }
        if (encrypted.length === 0 || encrypted.length > 8 * 1024) {
          throw new CredentialStorageError("invalid")
        }

        const envelope: StoredCredentialEnvelope = {
          schemaVersion: STORE_SCHEMA,
          encryptedPayload: encrypted.toString("base64"),
        }
        const body = `${JSON.stringify(envelope)}\n`
        if (body.includes(credential) || Buffer.byteLength(body, "utf8") > MAX_STORE_BYTES) {
          throw new CredentialStorageError("invalid")
        }

        try {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await chmod(directory, 0o700)
          if (!(await privateDirectory(directory))) {
            throw new CredentialStorageError("invalid")
          }
          if (await privateRegularFile(storePath)) {
            // Validation above deliberately happens before the replacement.
          }

          const temporaryPath = path.join(
            directory,
            `.credential.${process.pid}.${revisionValue()}.tmp`,
          )
          let handle
          try {
            handle = await open(temporaryPath, "wx", 0o600)
            await handle.writeFile(body, { encoding: "utf8" })
            await handle.sync()
            await handle.close()
            handle = undefined
            await rename(temporaryPath, storePath)
            await chmod(storePath, 0o600)
            const directoryHandle = await open(directory, "r")
            try {
              await directoryHandle.sync()
            } finally {
              await directoryHandle.close()
            }
          } catch (error) {
            if (handle !== undefined) await handle.close().catch(() => undefined)
            await unlink(temporaryPath).catch(() => undefined)
            throw error
          }
        } catch (error) {
          if (error instanceof CredentialStorageError) throw error
          throw new CredentialStorageError("io")
        }
        return snapshot
      })
    },

    clearIfCurrent(revision: string): Promise<boolean> {
      return exclusive(async () => {
        requireReady()
        const envelope = await readEnvelope()
        if (envelope === null) return true
        if (decryptPayload(envelope).revision !== revision) return false
        try {
          await unlink(storePath)
          return true
        } catch {
          throw new CredentialStorageError("io")
        }
      })
    },
  }
}

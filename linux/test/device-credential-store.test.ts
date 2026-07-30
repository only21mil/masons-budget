import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createPairedDeviceController } from "../electron/convexMutations.ts"
import {
  CredentialStorageError,
  createDeviceCredentialStore,
  type SafeStorageAdapter,
} from "../electron/deviceCredentialStore.ts"

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vv-device-store-"))
  roots.push(root)
  return root
}

function protectedStorage(
  overrides: Partial<SafeStorageAdapter> = {},
): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => {
      const text = value.toString("utf8")
      if (!text.startsWith("protected:")) throw new Error("invalid")
      return text.slice("protected:".length)
    },
    ...overrides,
  }
}

function fixture() {
  return {
    deploymentOrigin: "https://example.convex.cloud",
    deviceId: "abcdefghijklmnopqrs",
    deviceCredential: "abcdefghijklmnopqrstuvwxyz0123456789_AAAAAA",
    pairedAt: 1_774_000_000_000,
    capabilities: ["transaction.upsert", "transaction.delete"],
  } as const
}

describe("paired-device credential storage", () => {
  it.each([
    {
      label: "before app readiness",
      ready: false,
      backend: "gnome_libsecret",
      encryption: true,
      expected: "app-not-ready",
    },
    {
      label: "without encryption",
      ready: true,
      backend: "gnome_libsecret",
      encryption: false,
      expected: "encryption-unavailable",
    },
    {
      label: "with basic_text",
      ready: true,
      backend: "basic_text",
      encryption: true,
      expected: "unsafe-linux-backend",
    },
    {
      label: "with unknown backend",
      ready: true,
      backend: "unknown",
      encryption: true,
      expected: "unsafe-linux-backend",
    },
  ])("refuses storage $label", async ({ ready, backend, encryption, expected }) => {
    const store = createDeviceCredentialStore({
      appReady: () => ready,
      platform: "linux",
      safeStorage: protectedStorage({
        isEncryptionAvailable: () => encryption,
        getSelectedStorageBackend: () => backend,
      }),
      userDataPath: await temporaryRoot(),
    })

    expect(store.readiness()).toBe(expected)
    await expect(store.save(fixture())).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("writes an encrypted 0600 file beneath a 0700 directory and round-trips", async () => {
    const root = await temporaryRoot()
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })

    const saved = await store.save(fixture())
    const directory = path.join(root, "paired-device")
    const file = path.join(directory, "credential.json")
    const body = await readFile(file, "utf8")

    expect(body).not.toContain(fixture().deviceCredential)
    expect(body).not.toContain(fixture().deploymentOrigin)
    expect(body).not.toContain(fixture().deviceId)
    expect(body).not.toContain("transaction.upsert")
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await expect(store.load()).resolves.toEqual(saved)
  })

  it.each([
    ["deploymentOrigin", "https://attacker.convex.cloud"],
    ["deviceId", "attacker_device_abcdefghijkl"],
    ["capabilities", ["btcAccount.upsert"]],
  ])("rejects plaintext %s injection before opening a network request", async (field, value) => {
    const root = await temporaryRoot()
    const credentialStore = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })
    await credentialStore.save(fixture())
    const file = path.join(root, "paired-device", "credential.json")
    const envelope = JSON.parse(await readFile(file, "utf8"))
    envelope[field] = value
    await writeFile(file, JSON.stringify(envelope), { mode: 0o600 })
    const post = vi.fn()
    const controller = createPairedDeviceController({
      store: credentialStore,
      writesEnabled: () => true,
      post,
    })

    await expect(controller.mutate({
      kind: "transaction.delete",
      requestId: "request_tamper",
      actor: "victor",
      id: "tx-1",
      owner: "victor",
    })).resolves.toMatchObject({ status: "failed", code: "credential-storage" })
    expect(post).not.toHaveBeenCalled()
  })

  it("fails closed on corrupt, oversized, and symlinked files", async () => {
    const root = await temporaryRoot()
    const directory = path.join(root, "paired-device")
    const file = path.join(directory, "credential.json")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: root,
    })

    await writeFile(file, "{not-json", { mode: 0o600 })
    await expect(store.load()).rejects.toBeInstanceOf(CredentialStorageError)

    await writeFile(file, "x".repeat(17 * 1024), { mode: 0o600 })
    await expect(store.load()).rejects.toMatchObject({ code: "invalid" })

    const target = path.join(root, "target")
    await writeFile(target, "{}", { mode: 0o600 })
    const { unlink } = await import("node:fs/promises")
    await unlink(file)
    await symlink(target, file)
    await expect(store.load()).rejects.toMatchObject({ code: "invalid" })
  })

  it("refuses capabilities outside the closed mutation vocabulary", async () => {
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: await temporaryRoot(),
    })

    await expect(store.save({
      ...fixture(),
      capabilities: ["admin.everything" as never],
    })).rejects.toMatchObject({ code: "invalid" })
  })

  it("clears only the credential revision that received the rejection", async () => {
    const store = createDeviceCredentialStore({
      appReady: () => true,
      platform: "linux",
      safeStorage: protectedStorage(),
      userDataPath: await temporaryRoot(),
    })

    const first = await store.save(fixture())
    const second = await store.save({
      ...fixture(),
      deviceCredential: "replacement_abcdefghijklmnopqrstuvwxyz01234567",
    })

    await expect(store.clearIfCurrent(first.revision)).resolves.toBe(false)
    await expect(store.load()).resolves.toEqual(second)
    await expect(store.clearIfCurrent(second.revision)).resolves.toBe(true)
    await expect(store.load()).resolves.toBeNull()
  })
})

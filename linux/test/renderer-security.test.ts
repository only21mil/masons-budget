import { pathToFileURL } from "node:url"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { createRendererSecurityPolicy } from "../electron/rendererSecurity.ts"

describe("renderer URL security policy", () => {
  it("matches the exact development origin and document instead of prefixes", () => {
    const policy = createRendererSecurityPolicy(
      "/opt/vogel-vault/dist",
      "http://127.0.0.1:5173/app?mode=dev",
    )

    expect(policy.allowsDocument("http://127.0.0.1:5173/app?mode=dev#route")).toBe(true)
    expect(policy.allowsDocument("http://127.0.0.1:5173/app/child?mode=dev")).toBe(false)
    expect(policy.allowsDocument("http://127.0.0.1:5173/app?mode=other")).toBe(false)
    expect(policy.allowsDocument("http://127.0.0.1:5173.attacker.test/app?mode=dev")).toBe(false)
    expect(policy.allowsResource("http://127.0.0.1:5173/assets/index.js")).toBe(true)
    expect(policy.allowsResource("ws://127.0.0.1:5173/hmr")).toBe(true)
    expect(policy.allowsResource("https://127.0.0.1:5173/assets/index.js")).toBe(false)
  })

  it("accepts every loopback spelling for the development server", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const policy = createRendererSecurityPolicy("/opt/vogel-vault/dist", `http://${host}:5173/`)
      expect(policy.allowsDocument(`http://${host}:5173/`)).toBe(true)
    }
  })

  it("pins the development server to loopback, failing closed on any other host", () => {
    for (const url of [
      "http://192.168.1.20:5173/",
      "http://dev-box.local:5173/",
      "https://vite.example.test/",
      "http://0.0.0.0:5173/",
    ]) {
      expect(() => createRendererSecurityPolicy("/tmp/dist", url)).toThrow(
        "VITE_DEV_SERVER_URL is not a trusted renderer URL",
      )
    }
  })

  it("requires the exact packaged index for IPC and contains resources by path", () => {
    const dist = "/opt/Vogel Vault/dist"
    const policy = createRendererSecurityPolicy(dist)

    expect(policy.allowsDocument(pathToFileURL(path.join(dist, "index.html")).href)).toBe(true)
    expect(policy.allowsDocument(pathToFileURL(path.join(dist, "other.html")).href)).toBe(false)
    expect(policy.allowsResource(pathToFileURL(path.join(dist, "assets", "index.js")).href)).toBe(true)
    expect(policy.allowsResource(pathToFileURL("/opt/Vogel Vault/dist-evil/index.js").href)).toBe(false)
    expect(policy.allowsResource(pathToFileURL(path.join(dist, "..", "secret")).href)).toBe(false)
    expect(policy.allowsResource("https://example.test/index.js")).toBe(false)
  })

  it("rejects malformed or credential-bearing development configuration", () => {
    expect(() =>
      createRendererSecurityPolicy("/tmp/dist", "https://user:secret@example.test/"),
    ).toThrow()
    expect(() =>
      createRendererSecurityPolicy("/tmp/dist", "file:///tmp/dist/index.html"),
    ).toThrow()
  })
})

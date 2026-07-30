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

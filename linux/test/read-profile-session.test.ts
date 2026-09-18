import { describe, expect, it } from "vitest"

import { createReadProfileSessions } from "../electron/readProfileSession.ts"

describe("main-owned read profile sessions", () => {
  it("starts adult, permits an adult transition, and binds the resulting profile", () => {
    const sessions = createReadProfileSessions<object>()
    const sender = {}

    expect(sessions.current(sender)).toBe("victor")
    expect(sessions.activate(sender, "rachel")).toEqual({
      status: "active",
      profile: "rachel",
    })
    expect(sessions.current(sender)).toBe("rachel")
  })

  it("allows entering a child profile but refuses every later escalation", () => {
    const sessions = createReadProfileSessions<object>()
    const sender = {}

    expect(sessions.activate(sender, "mason")).toEqual({
      status: "active",
      profile: "mason",
    })
    expect(sessions.activate(sender, "victor")).toEqual({ status: "rejected" })
    expect(sessions.activate(sender, "maddox")).toEqual({ status: "rejected" })
    expect(sessions.current(sender)).toBe("mason")
    expect(sessions.activate(sender, "mason")).toEqual({
      status: "active",
      profile: "mason",
    })
  })

  it("rejects malformed profiles and keeps sessions isolated by sender", () => {
    const sessions = createReadProfileSessions<object>()
    const first = {}
    const second = {}

    expect(sessions.activate(first, { profile: "mason" })).toEqual({ status: "rejected" })
    expect(sessions.activate(first, "unknown")).toEqual({ status: "rejected" })
    expect(sessions.activate(first, "maddox")).toEqual({
      status: "active",
      profile: "maddox",
    })
    expect(sessions.current(second)).toBe("victor")
  })
})

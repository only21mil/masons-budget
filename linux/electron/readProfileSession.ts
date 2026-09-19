// Main-process authority for profile-scoped finance reads.
//
// The renderer may request a profile transition, but it never supplies the
// viewer attached to a finance query. Once a session enters a child profile it
// cannot escalate to another profile without restarting the local app session,
// matching the shared allowed-switch rule.

import type {
  VogelVaultMember,
  VogelVaultReadProfileResult,
} from "../shared/ipc.ts"

const MEMBERS = ["victor", "rachel", "mason", "maddox"] as const
/**
 * Exported because write authorization must agree with read containment: the
 * same set that may switch profiles is the set that may write another
 * member's ledger.
 */
export const ADULTS: ReadonlySet<VogelVaultMember> = new Set(["victor", "rachel"])

function isMember(value: unknown): value is VogelVaultMember {
  return typeof value === "string" && (MEMBERS as readonly string[]).includes(value)
}

export interface ReadProfileSessions<Key extends object> {
  activate(key: Key, profile: unknown): VogelVaultReadProfileResult
  current(key: Key): VogelVaultMember
}

export function createReadProfileSessions<Key extends object>(
  initialProfile: VogelVaultMember = "victor",
): ReadProfileSessions<Key> {
  const sessions = new WeakMap<Key, VogelVaultMember>()

  return {
    activate(key, requested): VogelVaultReadProfileResult {
      if (!isMember(requested)) return { status: "rejected" }
      const current = sessions.get(key) ?? initialProfile
      if (!ADULTS.has(current) && requested !== current) return { status: "rejected" }
      sessions.set(key, requested)
      return { status: "active", profile: requested }
    },

    current(key): VogelVaultMember {
      return sessions.get(key) ?? initialProfile
    },
  }
}

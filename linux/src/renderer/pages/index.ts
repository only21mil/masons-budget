// Route registry. The 20 primary pages of the cockpit.

import type { FamilyMember } from "@vogel-vault/domain/family"

import type { NavSection } from "../components/index.ts"
import { adminPageManifest } from "./admin/index.tsx"
import { financePageManifest } from "./finance/index.tsx"
import { tasksPageManifest } from "./tasks/index.tsx"
import { type PageDefinition, type PageManifest, visiblePages } from "./types.ts"

export { adminPageManifest, financePageManifest, tasksPageManifest }

export const PAGE_MANIFESTS: readonly PageManifest[] = [
  financePageManifest,
  tasksPageManifest,
  adminPageManifest,
]

export const ALL_PAGES: readonly PageDefinition[] = PAGE_MANIFESTS.flatMap(
  (manifest) => manifest.pages,
)

export const DEFAULT_ROUTE = "dashboard"

/** Nav sections for a profile, with adult-only pages removed for children. */
export function navSectionsFor(member: FamilyMember): NavSection[] {
  return PAGE_MANIFESTS.map((manifest) => ({
    id: manifest.id,
    label: manifest.label,
    items: visiblePages(manifest, member).map((page) => ({
      id: page.id,
      label: page.label,
      icon: page.icon,
    })),
  })).filter((section) => section.items.length > 0)
}

/**
 * Resolve a route for a profile. Returns null when the profile may not see it,
 * so the router can fall back rather than rendering an adult page for a child.
 */
export function resolvePage(routeId: string, member: FamilyMember): PageDefinition | null {
  const page = ALL_PAGES.find((candidate) => candidate.id === routeId)
  if (!page) return null
  const isChild = member === "mason" || member === "maddox"
  if (isChild && page.adultOnly) return null
  return page
}

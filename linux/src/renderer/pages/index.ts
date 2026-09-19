// Route registry. Primary navigation is five tabs; secondary routes stay reachable.

import type { FamilyMember } from "@vogel-vault/domain/family"

import type { NavSection } from "../components/index.ts"
import {
  DEFAULT_ROUTE,
  PRIMARY_NAV_IDS,
  canonicalRoute,
  primaryNavId,
} from "../navigation.ts"
import { adminPageManifest } from "./admin/index.tsx"
import { financePageManifest } from "./finance/index.tsx"
import { pricePageDefinition } from "./finance/priceRoute.tsx"
import { tasksPageManifest } from "./tasks/index.tsx"
import { type PageDefinition, type PageManifest } from "./types.ts"

export {
  DEFAULT_ROUTE,
  PRIMARY_NAV_IDS,
  canonicalRoute,
  primaryNavId,
}

const PAGE_MANIFESTS: readonly PageManifest[] = [
  financePageManifest,
  tasksPageManifest,
  adminPageManifest,
]

export const ALL_PAGES: readonly PageDefinition[] = PAGE_MANIFESTS.flatMap(
  (manifest) => manifest.pages,
)

const ROUTE_ONLY_PAGES: readonly PageDefinition[] = [pricePageDefinition]
export const ROUTABLE_PAGES: readonly PageDefinition[] = [...ALL_PAGES, ...ROUTE_ONLY_PAGES]

/** Nav sections for a profile — five primary tabs only. */
export function navSectionsFor(member: FamilyMember): NavSection[] {
  const items = PRIMARY_NAV_IDS.flatMap((id) => {
    const page = resolvePage(id, member)
    return page
      ? [{
          id: page.id,
          label: page.label,
          icon: page.icon,
        }]
      : []
  })

  if (items.length === 0) return []

  return [{
    id: "primary",
    label: "Ledger",
    items,
  }]
}

/**
 * Resolve a route for a profile. Returns null when the profile may not see it,
 * so the router can fall back rather than rendering an adult page for a child.
 */
export function resolvePage(routeId: string, member: FamilyMember): PageDefinition | null {
  const canonical = canonicalRoute(routeId)
  const page = ROUTABLE_PAGES.find((candidate) => candidate.id === canonical)
  if (!page) return null
  const isChild = member === "mason" || member === "maddox"
  if (isChild && page.adultOnly) return null
  return page
}

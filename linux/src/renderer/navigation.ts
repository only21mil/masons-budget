// Shared route ids and aliases — no page imports, safe for AppState and the registry.

export const PRIMARY_NAV_IDS = [
  "home",
  "budget",
  "activity",
  "bitcoin",
  "tasks",
] as const

export type PrimaryNavId = (typeof PRIMARY_NAV_IDS)[number]

export type BitcoinSegment = "overview" | "net-worth" | "retirement"

export type TaskSegment = "today" | "inbox" | "upcoming" | "flagged" | "projects"

export const DEFAULT_ROUTE: PrimaryNavId = "home"

const ROUTE_ALIASES: Readonly<Record<string, string>> = {
  dashboard: "home",
  today: "tasks",
  inbox: "tasks",
  upcoming: "tasks",
  flagged: "tasks",
  projects: "tasks",
  retirement: "bitcoin",
  "net-worth": "bitcoin",
}

export function canonicalRoute(routeId: string): string {
  return ROUTE_ALIASES[routeId] ?? routeId
}

export function bitcoinSegmentForRoute(routeId: string): BitcoinSegment {
  if (routeId === "net-worth") return "net-worth"
  if (routeId === "retirement") return "retirement"
  return "overview"
}

export function taskSegmentForRoute(routeId: string): TaskSegment {
  if (routeId === "inbox") return "inbox"
  if (routeId === "upcoming") return "upcoming"
  if (routeId === "flagged") return "flagged"
  if (routeId === "projects") return "projects"
  return "today"
}

export function primaryNavId(routeId: string): string {
  const canonical = canonicalRoute(routeId)
  if (canonical === "bitcoin" || routeId === "bitcoin-buys" || routeId === "bills") {
    return "bitcoin"
  }
  return canonical
}

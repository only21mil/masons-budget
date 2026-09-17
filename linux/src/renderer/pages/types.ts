import type { ComponentType } from "react"

import type { IconName } from "../components/index.ts"

export interface PageDefinition {
  readonly id: string
  readonly label: string
  readonly icon: IconName
  readonly Component: ComponentType
  /**
   * Pages an adult sees but a child does not. Enforced by the router as a second
   * line of defence — the nav already hides them, but a child profile must not
   * be able to render an adult surface even if a route id is forced.
   */
  readonly adultOnly?: boolean
}

export interface PageManifest {
  readonly id: string
  readonly label: string
  readonly pages: readonly PageDefinition[]
}

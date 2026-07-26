// App-wide state: which profile is active, which route is showing, and the QA
// state override that lets every page be inspected in all five states.

import { createContext, useCallback, useContext, useMemo, useState } from "react"
import type { ReactNode } from "react"

import { type FamilyMember, allowedSwitchTargets } from "@vogel-vault/domain/family"
import type { Freshness } from "@vogel-vault/domain/readModel"

import { type FixtureEnvelope, buildSanitizedFixtureEnvelope, fixtureEnvelopeInState } from "../data/fixtures.ts"

export type StateOverride = Freshness | "normal"

interface AppStateValue {
  readonly activeProfile: FamilyMember
  readonly switchProfile: (next: FamilyMember) => void
  readonly switchTargets: readonly FamilyMember[]
  readonly route: string
  readonly navigate: (id: string) => void
  readonly locked: boolean
  readonly setLocked: (locked: boolean) => void
  readonly stateOverride: StateOverride
  readonly setStateOverride: (state: StateOverride) => void
  readonly data: FixtureEnvelope
}

const AppStateContext = createContext<AppStateValue | null>(null)

export interface AppStateProviderProps {
  children: ReactNode
  /**
   * Starting values. Tests use these to render a specific profile/route/state in
   * a single pass — a setState from a child would not be applied by
   * renderToStaticMarkup, so seeding is the only way to render off-defaults.
   */
  initialProfile?: FamilyMember
  initialRoute?: string
  initialStateOverride?: StateOverride
}

export function AppStateProvider({
  children,
  initialProfile = "victor",
  initialRoute = "dashboard",
  initialStateOverride = "normal",
}: AppStateProviderProps) {
  const [activeProfile, setActiveProfile] = useState<FamilyMember>(initialProfile)
  const [route, setRoute] = useState(initialRoute)
  const [locked, setLocked] = useState(false)
  const [stateOverride, setStateOverride] = useState<StateOverride>(initialStateOverride)

  const switchTargets = useMemo(() => allowedSwitchTargets(activeProfile), [activeProfile])

  const switchProfile = useCallback(
    (next: FamilyMember) => {
      // Enforce the switch rule here as well as in the picker. A kid profile
      // must not be able to reach an adult one even if the UI is bypassed.
      setActiveProfile((current) => (allowedSwitchTargets(current).includes(next) ? next : current))
    },
    [],
  )

  const data = useMemo(
    () =>
      stateOverride === "normal"
        ? buildSanitizedFixtureEnvelope(activeProfile)
        : fixtureEnvelopeInState(activeProfile, stateOverride),
    [activeProfile, stateOverride],
  )

  const value = useMemo(
    () => ({
      activeProfile,
      switchProfile,
      switchTargets,
      route,
      navigate: setRoute,
      locked,
      setLocked,
      stateOverride,
      setStateOverride,
      data,
    }),
    [activeProfile, switchProfile, switchTargets, route, locked, stateOverride, data],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (!value) throw new Error("useAppState must be used inside AppStateProvider")
  return value
}

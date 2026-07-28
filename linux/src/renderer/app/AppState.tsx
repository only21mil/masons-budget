// App-wide state: which profile is active, which route is showing, which month
// the money screens are reporting on, and the QA state override that lets every
// page be inspected in all five states.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

import { type FamilyMember, allowedSwitchTargets } from "@vogel-vault/domain/family"
import type { Freshness, MonthKey } from "@vogel-vault/domain/readModel"

import { type FixtureEnvelope, buildSanitizedFixtureEnvelope, fixtureEnvelopeInState } from "../data/fixtures.ts"
import { loadConvexRowEnvelope } from "../data/convexRows.ts"
import {
  type DisplayUnit,
  displayUnitFromStorageKey,
} from "../data/bitcoinDisplay.ts"

export type StateOverride = Freshness | "normal"

const DISPLAY_UNIT_STORAGE_KEY = "vogel-vault.display-unit"

interface AppStateValue {
  readonly activeProfile: FamilyMember
  readonly switchProfile: (next: FamilyMember) => void
  readonly switchTargets: readonly FamilyMember[]
  readonly route: string
  readonly navigate: (id: string) => void
  readonly locked: boolean
  readonly setLocked: (locked: boolean) => void
  /**
   * Month the money screens report on, or null to follow the data's own month.
   *
   * Held app-wide rather than inside the Budget page so the Dashboard headline
   * moves with it. Two screens quoting different months for one household is
   * how a number gets trusted when it should not be.
   */
  readonly selectedMonth: MonthKey | null
  readonly selectMonth: (month: MonthKey | null) => void
  readonly stateOverride: StateOverride
  readonly setStateOverride: (state: StateOverride) => void
  readonly displayUnit: DisplayUnit
  readonly setDisplayUnit: (unit: DisplayUnit) => void
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
  initialSelectedMonth?: MonthKey | null
  initialDisplayUnit?: DisplayUnit
  /** Exact envelope for headless financial-state regression tests. */
  initialData?: FixtureEnvelope
}

export function AppStateProvider({
  children,
  initialProfile = "victor",
  initialRoute = "dashboard",
  initialStateOverride = "normal",
  initialSelectedMonth = null,
  initialDisplayUnit,
  initialData,
}: AppStateProviderProps) {
  const [activeProfile, setActiveProfile] = useState<FamilyMember>(initialProfile)
  const [route, setRoute] = useState(initialRoute)
  const [locked, setLocked] = useState(false)
  const [stateOverride, setStateOverride] = useState<StateOverride>(initialStateOverride)
  const [selectedMonth, setSelectedMonth] = useState<MonthKey | null>(initialSelectedMonth)
  const [displayUnit, setStoredDisplayUnit] = useState<DisplayUnit>(
    () => initialDisplayUnit ?? readDisplayUnit(),
  )
  const [remoteData, setRemoteData] = useState<{
    readonly profile: FamilyMember
    readonly data: FixtureEnvelope
  } | null>(() => initialData ? { profile: initialProfile, data: initialData } : null)

  const switchTargets = useMemo(() => allowedSwitchTargets(activeProfile), [activeProfile])

  const setDisplayUnit = useCallback((unit: DisplayUnit) => {
    setStoredDisplayUnit(unit)
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(DISPLAY_UNIT_STORAGE_KEY, unit)
    } catch {
      // A blocked storage area must not make the display control unusable.
    }
  }, [])

  const switchProfile = useCallback(
    (next: FamilyMember) => {
      // Enforce the switch rule here as well as in the picker. A kid profile
      // must not be able to reach an adult one even if the UI is bypassed.
      setActiveProfile((current) => (allowedSwitchTargets(current).includes(next) ? next : current))
      // Drop the month with the profile. A month the previous profile had
      // records in may be empty for this one, and a blank screen after a
      // profile switch reads as a broken app rather than as a chosen filter.
      setSelectedMonth(null)
    },
    [],
  )

  useEffect(() => {
    if (stateOverride !== "normal") return
    const bridge = window.vogelVault
    if (!bridge) return

    let current = true
    setRemoteData(null)
    void loadConvexRowEnvelope(
      async (request) => {
        try {
          return await bridge.queryConvexRows(request)
        } catch {
          return { status: "error", code: "unavailable" }
        }
      },
      activeProfile,
    ).then((result) => {
      if (!current) return
      setRemoteData(result.status === "loaded" ? { profile: activeProfile, data: result.data } : null)
    })

    return () => {
      current = false
    }
  }, [activeProfile, stateOverride])

  const data = useMemo(
    () =>
      stateOverride === "normal"
        ? remoteData?.profile === activeProfile
          ? remoteData.data
          : buildSanitizedFixtureEnvelope(activeProfile)
        : fixtureEnvelopeInState(activeProfile, stateOverride),
    [activeProfile, remoteData, stateOverride],
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
      selectedMonth,
      selectMonth: setSelectedMonth,
      stateOverride,
      setStateOverride,
      displayUnit,
      setDisplayUnit,
      data,
    }),
    [
      activeProfile,
      switchProfile,
      switchTargets,
      route,
      locked,
      selectedMonth,
      stateOverride,
      displayUnit,
      setDisplayUnit,
      data,
    ],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (!value) throw new Error("useAppState must be used inside AppStateProvider")
  return value
}

function readDisplayUnit(): DisplayUnit {
  if (typeof window === "undefined") return "btc"
  try {
    return displayUnitFromStorageKey(window.localStorage.getItem(DISPLAY_UNIT_STORAGE_KEY))
  } catch {
    return "btc"
  }
}

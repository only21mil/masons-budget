// App-wide state: which profile is active, which route is showing, which Budget
// month is selected, and the QA state override that lets every page be inspected
// in all five states.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ReactNode } from "react"

import { type FamilyMember, allowedSwitchTargets } from "@vogel-vault/domain/family"
import { type Freshness, type MonthKey, monthOf } from "@vogel-vault/domain/readModel"

import { type FixtureEnvelope, buildSanitizedFixtureEnvelope, fixtureEnvelopeInState } from "../data/fixtures.ts"
import { loadConvexRowEnvelope } from "../data/convexRows.ts"
import {
  type LinuxFinanceReadModel,
  loadLinuxFinanceReadModel,
} from "../data/financeReadModel.ts"
import {
  type DisplayUnit,
  displayUnitFromStorageKey,
} from "../data/bitcoinDisplay.ts"
import {
  EMPTY_MUTATION_CONTROLLER,
  type DataOrigin,
  type MutationControllerState,
  type MutationGate,
  type PairingRequest,
  type PairingResult,
  type PairingStatus,
  type RendererMutationAdapter,
  type RendererMutationKind,
  type RendererMutationRequest,
  type RendererMutationResult,
  type UnpairResult,
  beginMutation,
  finishRefresh,
  isEntityPending,
  mutationGate,
  optimisticEnvelope,
  settleMutation,
} from "../data/mutations.ts"

export type StateOverride = Freshness | "normal"
export type LedgerTheme = "dark" | "light"

const DISPLAY_UNIT_STORAGE_KEY = "vogel-vault.display-unit"
const LEDGER_THEME_STORAGE_KEY = "vogel-vault.ledger-theme"
const SCANLINES_STORAGE_KEY = "vogel-vault.scanlines"
const PHOSPHOR_STORAGE_KEY = "vogel-vault.phosphor"
const BUDGET_ALERTS_STORAGE_KEY = "vogel-vault.budget-alerts"
const LEGACY_BIOMETRIC_STORAGE_KEY = "vogel-vault.biometric-unlock"

interface AppStateValue {
  readonly activeProfile: FamilyMember
  readonly switchProfile: (next: FamilyMember) => void
  readonly switchTargets: readonly FamilyMember[]
  readonly route: string
  readonly navigate: (id: string) => void
  readonly locked: boolean
  readonly setLocked: (locked: boolean) => void
  /** Canonical current UTC/server month used by Dashboard MTD. */
  readonly currentMonth: MonthKey
  /**
   * Month the Budget screen reports on, or null to follow the budget document.
   * Dashboard MTD remains anchored to the current UTC/server month.
   */
  readonly selectedMonth: MonthKey | null
  readonly selectMonth: (month: MonthKey | null) => void
  readonly stateOverride: StateOverride
  readonly setStateOverride: (state: StateOverride) => void
  readonly displayUnit: DisplayUnit
  readonly setDisplayUnit: (unit: DisplayUnit) => void
  readonly ledgerTheme: LedgerTheme
  readonly setLedgerTheme: (theme: LedgerTheme) => void
  readonly scanlinesEnabled: boolean
  readonly setScanlinesEnabled: (enabled: boolean) => void
  readonly phosphorEnabled: boolean
  readonly setPhosphorEnabled: (enabled: boolean) => void
  readonly budgetAlertsEnabled: boolean
  readonly setBudgetAlertsEnabled: (enabled: boolean) => void
  readonly data: FixtureEnvelope
  /** Finance/quote rows are remote-only and never synthesized from QA fixtures. */
  readonly financeModel: LinuxFinanceReadModel
  readonly dataOrigin: DataOrigin
  readonly mutationCapabilities: readonly RendererMutationKind[]
  readonly pairingStatus: PairingStatus | { readonly status: "loading" }
  readonly pairDevice: (request: PairingRequest) => Promise<PairingResult>
  readonly unpairDevice: () => Promise<UnpairResult>
  readonly mutationNotice: MutationControllerState["notice"]
  readonly mutationGate: (
    kind: RendererMutationKind,
    freshness: string,
    owner?: FamilyMember,
    selectedMonth?: string,
    persistedMonth?: string,
  ) => MutationGate
  readonly submitMutation: (request: RendererMutationRequest) => Promise<RendererMutationResult>
  readonly isMutationPending: (
    kind: RendererMutationKind,
    owner: FamilyMember,
    id: string,
    month?: string,
  ) => boolean
  readonly refresh: () => Promise<boolean>
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
  /** Canonical server month override for deterministic/bootstrap rendering. */
  initialCurrentMonth?: MonthKey
  initialSelectedMonth?: MonthKey | null
  initialDisplayUnit?: DisplayUnit
  /** Exact envelope for headless financial-state regression tests. */
  initialData?: FixtureEnvelope
  /** Exact remote finance state for deterministic renderer tests. */
  initialFinanceModel?: LinuxFinanceReadModel
  /** Tests may opt into writable seeded rows explicitly; fixtures stay read-only. */
  initialDataOrigin?: DataOrigin
  /** Renderer-local adapter until the preload contract is joined by the parent lane. */
  mutationAdapter?: RendererMutationAdapter | null
  /** Optional deterministic capability seed for static and interaction tests. */
  initialMutationCapabilities?: readonly RendererMutationKind[]
  /** Optional credential-free pairing seed for static Settings tests. */
  initialPairingStatus?: PairingStatus
}

export function AppStateProvider({
  children,
  initialProfile = "victor",
  initialRoute = "dashboard",
  initialStateOverride = "normal",
  initialCurrentMonth,
  initialSelectedMonth = null,
  initialDisplayUnit,
  initialData,
  initialFinanceModel,
  initialDataOrigin = "fixture",
  mutationAdapter,
  initialMutationCapabilities = [],
  initialPairingStatus,
}: AppStateProviderProps) {
  const [activeProfile, setActiveProfile] = useState<FamilyMember>(initialProfile)
  const [route, setRoute] = useState(initialRoute)
  const [locked, setLocked] = useState(false)
  const currentMonth = initialCurrentMonth ?? monthOf(new Date().toISOString().slice(0, 10))
  const [stateOverride, setStateOverride] = useState<StateOverride>(initialStateOverride)
  const [selectedMonth, setSelectedMonth] = useState<MonthKey | null>(initialSelectedMonth)
  const [displayUnit, setStoredDisplayUnit] = useState<DisplayUnit>(
    () => initialDisplayUnit ?? readDisplayUnit(),
  )
  const [ledgerTheme, setStoredLedgerTheme] = useState<LedgerTheme>(readLedgerTheme)
  // Scanlines are a texture preference, not a base layer: off for a new
  // profile, while a saved choice is always honoured.
  const [scanlinesEnabled, setStoredScanlinesEnabled] = useState(
    () => readBooleanPreference(SCANLINES_STORAGE_KEY, false),
  )
  const [phosphorEnabled, setStoredPhosphorEnabled] = useState(
    () => readBooleanPreference(PHOSPHOR_STORAGE_KEY, true),
  )
  const [budgetAlertsEnabled, setStoredBudgetAlertsEnabled] = useState(
    () => readBooleanPreference(BUDGET_ALERTS_STORAGE_KEY, true),
  )
  const [remoteData, setRemoteData] = useState<{
    readonly profile: FamilyMember
    readonly data: FixtureEnvelope
    readonly origin: DataOrigin
  } | null>(() =>
    initialData
      ? { profile: initialProfile, data: initialData, origin: initialDataOrigin }
      : null,
  )
  const [remoteFinance, setRemoteFinance] = useState<{
    readonly profile: FamilyMember
    readonly model: LinuxFinanceReadModel
  } | null>(() =>
    initialFinanceModel
      ? { profile: initialProfile, model: initialFinanceModel }
      : null,
  )
  const [remotePhase, setRemotePhase] = useState<{
    readonly profile: FamilyMember
    readonly status: "loading" | "settled"
  }>(() => ({
    profile: initialProfile,
    status: initialData || !rendererBridgeAvailable() ? "settled" : "loading",
  }))
  const lastCheckedRef = useRef<Partial<Record<FamilyMember, number>>>(
    initialData?.checkedAt === null || initialData?.checkedAt === undefined
      ? {}
      : { [initialProfile]: initialData.checkedAt },
  )
  const [mutationCapabilities, setMutationCapabilities] = useState<
    readonly RendererMutationKind[]
  >(initialMutationCapabilities)
  const [pairingStatus, setPairingStatus] = useState<
    PairingStatus | { readonly status: "loading" }
  >(
    initialPairingStatus ??
    (initialMutationCapabilities.length > 0
      ? {
          status: "paired",
          pairedAt: 0,
          capabilities: initialMutationCapabilities,
          writesEnabled: true,
        }
      : { status: "loading" }),
  )
  const [mutationController, setMutationController] =
    useState<MutationControllerState>(EMPTY_MUTATION_CONTROLLER)
  const [generation, setGeneration] = useState(0)
  const controllerRef = useRef(mutationController)
  const generationRef = useRef(0)

  const adapter = useMemo(
    () => mutationAdapter === undefined ? mutationAdapterFromWindow() : mutationAdapter,
    [mutationAdapter],
  )

  const updateController = useCallback(
    (next: MutationControllerState) => {
      controllerRef.current = next
      setMutationController(next)
    },
    [],
  )

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

  const setLedgerTheme = useCallback((theme: LedgerTheme) => {
    setStoredLedgerTheme(theme)
    writePreference(LEDGER_THEME_STORAGE_KEY, theme)
  }, [])
  const setScanlinesEnabled = useCallback((enabled: boolean) => {
    setStoredScanlinesEnabled(enabled)
    writePreference(SCANLINES_STORAGE_KEY, String(enabled))
  }, [])
  const setPhosphorEnabled = useCallback((enabled: boolean) => {
    setStoredPhosphorEnabled(enabled)
    writePreference(PHOSPHOR_STORAGE_KEY, String(enabled))
  }, [])
  const setBudgetAlertsEnabled = useCallback((enabled: boolean) => {
    setStoredBudgetAlertsEnabled(enabled)
    writePreference(BUDGET_ALERTS_STORAGE_KEY, String(enabled))
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      // Electron has no supported Linux OS-auth API. A legacy renderer preference
      // must never survive as apparent authority for profile switching.
      window.localStorage.removeItem(LEGACY_BIOMETRIC_STORAGE_KEY)
    } catch {
      // Blocked storage is already non-authoritative, so there is nothing to do.
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

  const loadRemote = useCallback(async (profile: FamilyMember, generation: number) => {
    if (generationRef.current === generation) {
      setRemotePhase({ profile, status: "loading" })
    }
    const bridge = window.vogelVault
    if (!bridge) {
      if (generationRef.current === generation) {
        setRemotePhase({ profile, status: "settled" })
      }
      return false
    }
    let profileResult: Awaited<ReturnType<typeof bridge.setReadProfile>>
    try {
      profileResult = await bridge.setReadProfile(profile)
    } catch {
      profileResult = { status: "rejected" as const }
    }
    if (profileResult.status !== "active" || profileResult.profile !== profile) {
      if (generationRef.current === generation) {
        setRemoteFinance({ profile, model: ERROR_FINANCE_MODEL })
        setRemotePhase({ profile, status: "settled" })
      }
      return false
    }
    const query = async (request: Parameters<typeof bridge.queryConvexRows>[0]) => {
      try {
        return await bridge.queryConvexRows(request)
      } catch {
        return { status: "error" as const, code: "unavailable" as const }
      }
    }
    const [result, financeModel] = await Promise.all([
      loadConvexRowEnvelope(query),
      loadLinuxFinanceReadModel(query),
    ])
    if (generationRef.current !== generation) return false
    setRemoteFinance({ profile, model: financeModel })
    if (result.status !== "loaded") {
      setRemotePhase({ profile, status: "settled" })
      return false
    }
    const succeeded = rowReadSucceeded(result.data) && financeReadSucceeded(financeModel)
    let checkedAt = lastCheckedRef.current[profile] ?? null
    if (succeeded) {
      checkedAt = Date.now()
      lastCheckedRef.current[profile] = checkedAt
    }
    setRemoteData({
      profile,
      data: { ...result.data, checkedAt },
      origin: "remote",
    })
    setRemotePhase({ profile, status: "settled" })
    return succeeded
  }, [])

  useEffect(() => {
    if (stateOverride !== "normal") return
    const generation = ++generationRef.current
    setGeneration(generation)
    if (controllerRef.current !== EMPTY_MUTATION_CONTROLLER) {
      updateController({
        ...controllerRef.current,
        pending: {},
        committed: [],
        notice: null,
      })
    }
    void loadRemote(activeProfile, generation)
  }, [activeProfile, loadRemote, stateOverride, updateController])

  useEffect(() => {
    if (!adapter) {
      setMutationCapabilities([])
      setPairingStatus({ status: "unavailable" })
      return
    }
    let current = true
    void adapter.getPairingStatus().then(
      (status) => {
        if (current) {
          setMutationCapabilities(
            status.status === "paired" && status.writesEnabled
              ? status.capabilities
              : [],
          )
          setPairingStatus(status)
        }
      },
      () => {
        if (current) {
          setMutationCapabilities([])
          setPairingStatus({ status: "unavailable" })
        }
      },
    )
    return () => {
      current = false
    }
  }, [adapter])

  const pairDevice = useCallback(
    async (request: PairingRequest): Promise<PairingResult> => {
      if (!adapter) return { status: "disabled" }
      let result: PairingResult
      try {
        result = await adapter.pairDevice(request)
      } catch {
        result = { status: "failed", code: "unavailable" }
      }
      if (result.status === "paired") {
        setPairingStatus({ ...result, writesEnabled: true })
        setMutationCapabilities(result.capabilities)
      }
      return result
    },
    [adapter],
  )

  const unpairDevice = useCallback(async (): Promise<UnpairResult> => {
    if (!adapter) return { status: "unavailable" }
    let result: UnpairResult
    try {
      // Main revokes remotely before clearing protected local state.
      result = await adapter.unpairDevice()
    } catch {
      result = { status: "unavailable" }
    }
    if (result.status === "ok" || result.status === "unpaired") {
      setPairingStatus({ status: "unpaired", writesEnabled: false })
      setMutationCapabilities([])
    }
    return result
  }, [adapter])

  const baseData = useMemo(
    () => stateOverride === "normal"
        ? remoteData?.profile === activeProfile
          ? remoteData.data
          : rendererBridgeAvailable() &&
              (remotePhase.profile !== activeProfile || remotePhase.status === "loading")
            ? fixtureEnvelopeInState(activeProfile, "loading")
            : buildSanitizedFixtureEnvelope(activeProfile)
        : fixtureEnvelopeInState(activeProfile, stateOverride),
    [activeProfile, remoteData, remotePhase, stateOverride],
  )
  const dataOrigin: DataOrigin =
    stateOverride === "normal" && remoteData?.profile === activeProfile
      ? remoteData.origin
      : "fixture"
  const financeModel =
    stateOverride === "normal" && remoteFinance?.profile === activeProfile
      ? remoteFinance.model
      : stateOverride === "normal" && typeof window !== "undefined" && window.vogelVault
        ? LOADING_FINANCE_MODEL
        : EMPTY_FINANCE_MODEL
  const data = useMemo(
    () => optimisticEnvelope(baseData, mutationController, activeProfile, generation),
    [activeProfile, baseData, generation, mutationController],
  )

  const refresh = useCallback(async () => {
    if (stateOverride !== "normal") return false
    const nextGeneration = generationRef.current
    const loaded = await loadRemote(activeProfile, nextGeneration)
    updateController(
      finishRefresh(
        controllerRef.current,
        activeProfile,
        nextGeneration,
        loaded,
      ),
    )
    return loaded
  }, [activeProfile, loadRemote, stateOverride, updateController])

  const gateMutation = useCallback(
    (
      kind: RendererMutationKind,
      freshness: string,
      owner?: FamilyMember,
      selected?: string,
      persisted?: string,
    ) =>
      mutationGate({
        dataOrigin,
        bridgeAvailable: Boolean(adapter),
        writesEnabled:
          pairingStatus.status === "paired" && pairingStatus.writesEnabled,
        capabilities: mutationCapabilities,
        kind,
        actor: activeProfile,
        owner,
        freshness,
        selectedMonth: selected,
        persistedMonth: persisted,
      }),
    [activeProfile, adapter, dataOrigin, mutationCapabilities, pairingStatus],
  )

  const submitMutation = useCallback(
    async (request: RendererMutationRequest): Promise<RendererMutationResult> => {
      const owner = "owner" in request ? request.owner : data.budget.value?.owner
      const freshness = mutationFreshness(data, request.kind)
      const persistedMonth = data.budget.value?.month
      const requestMonth = "month" in request ? request.month : undefined
      const gate = mutationGate({
        dataOrigin,
        bridgeAvailable: Boolean(adapter),
        writesEnabled:
          pairingStatus.status === "paired" && pairingStatus.writesEnabled,
        capabilities: mutationCapabilities,
        kind: request.kind,
        actor: activeProfile,
        owner,
        freshness,
        selectedMonth: requestMonth,
        persistedMonth,
      })
      if (!adapter || request.actor !== activeProfile || !gate.allowed) {
        return {
          status: adapter ? "disabled" : "not-configured",
          requestId: request.requestId,
          kind: request.kind,
        }
      }
      const generationAtStart = generationRef.current
      const started = beginMutation(
        controllerRef.current,
        request,
        data,
        activeProfile,
        generationAtStart,
      )
      if (started.status === "busy") {
        return {
          status: "failed",
          requestId: request.requestId,
          kind: request.kind,
          code: "conflict",
        }
      }
      updateController(started.state)
      let result: RendererMutationResult
      try {
        result = await adapter.mutateConvexRow(request)
      } catch {
        result = {
          status: "failed",
          requestId: request.requestId,
          kind: request.kind,
          code: "unavailable",
        }
      }
      const settled = settleMutation(
        controllerRef.current,
        started.pending,
        result,
        activeProfile,
        generationAtStart,
      )
      updateController(settled)
      if (result.status === "ok") {
        const refreshed = await loadRemote(activeProfile, generationAtStart)
        updateController(
          finishRefresh(
            controllerRef.current,
            activeProfile,
            generationAtStart,
            refreshed,
            [started.pending.request.requestId],
          ),
        )
      } else if (result.status === "missing") {
        await loadRemote(activeProfile, generationAtStart)
      }
      return result
    },
    [
      activeProfile,
      adapter,
      data,
      dataOrigin,
      loadRemote,
      mutationCapabilities,
      pairingStatus,
      updateController,
    ],
  )

  const mutationPending = useCallback(
    (kind: RendererMutationKind, owner: FamilyMember, id: string, month?: string) =>
      isEntityPending(controllerRef.current, kind, owner, id, month),
    [],
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
      currentMonth,
      selectedMonth,
      selectMonth: setSelectedMonth,
      stateOverride,
      setStateOverride,
      displayUnit,
      setDisplayUnit,
      ledgerTheme,
      setLedgerTheme,
      scanlinesEnabled,
      setScanlinesEnabled,
      phosphorEnabled,
      setPhosphorEnabled,
      budgetAlertsEnabled,
      setBudgetAlertsEnabled,
      data,
      financeModel,
      dataOrigin,
      mutationCapabilities,
      pairingStatus,
      pairDevice,
      unpairDevice,
      mutationNotice: mutationController.notice,
      mutationGate: gateMutation,
      submitMutation,
      isMutationPending: mutationPending,
      refresh,
    }),
    [
      activeProfile,
      switchProfile,
      switchTargets,
      route,
      locked,
      currentMonth,
      selectedMonth,
      stateOverride,
      displayUnit,
      setDisplayUnit,
      ledgerTheme,
      setLedgerTheme,
      scanlinesEnabled,
      setScanlinesEnabled,
      phosphorEnabled,
      setPhosphorEnabled,
      budgetAlertsEnabled,
      setBudgetAlertsEnabled,
      data,
      financeModel,
      dataOrigin,
      mutationCapabilities,
      pairingStatus,
      pairDevice,
      unpairDevice,
      mutationController.notice,
      gateMutation,
      submitMutation,
      mutationPending,
      refresh,
    ],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

const EMPTY_FINANCE_MODEL: LinuxFinanceReadModel = {
  finance: { status: "empty", value: null },
  marketQuotes: { status: "empty", value: null },
}

const LOADING_FINANCE_MODEL: LinuxFinanceReadModel = {
  finance: { status: "loading", value: null },
  marketQuotes: { status: "loading", value: null },
}

const ERROR_FINANCE_MODEL: LinuxFinanceReadModel = {
  finance: { status: "error", value: null, code: "invalid-request" },
  marketQuotes: { status: "error", value: null, code: "invalid-request" },
}

/** Global refresh succeeds only after both finance reads reach a terminal non-error state. */
export function financeReadSucceeded(model: LinuxFinanceReadModel): boolean {
  return model.finance.status !== "error" && model.finance.status !== "loading" &&
    model.marketQuotes.status !== "error" && model.marketQuotes.status !== "loading"
}

function rowReadSucceeded(data: FixtureEnvelope): boolean {
  return [
    data.transactions,
    data.income,
    data.budget,
    data.btcBalanceDocument,
    data.btcAccounts,
    data.btcBuys,
    data.billPays,
    data.btcTransfers,
    data.todos,
  ].every((slice) => slice.status === "live" || slice.status === "empty")
}

function rendererBridgeAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.vogelVault)
}

function mutationAdapterFromWindow(): RendererMutationAdapter | null {
  if (typeof window === "undefined") return null
  const candidate = window.vogelVault as unknown as Partial<RendererMutationAdapter> | undefined
  if (
    typeof candidate?.getPairingStatus !== "function" ||
    typeof candidate.pairDevice !== "function" ||
    typeof candidate.mutateConvexRow !== "function" ||
    typeof candidate.unpairDevice !== "function"
  ) {
    return null
  }
  return {
    getPairingStatus: () => candidate.getPairingStatus!(),
    pairDevice: (request) => candidate.pairDevice!(request),
    mutateConvexRow: (request) => candidate.mutateConvexRow!(request),
    unpairDevice: () => candidate.unpairDevice!(),
  }
}

function mutationFreshness(data: FixtureEnvelope, kind: RendererMutationKind): string {
  if (kind.startsWith("transaction.")) return data.transactions.status
  if (kind.startsWith("todo.")) return data.todos.status
  if (kind.startsWith("budgetCategory.")) return data.budget.status
  if (kind.startsWith("btcBuy.")) return data.btcBuys.status
  if (kind.startsWith("btcBillPay.")) return data.billPays.status
  if (kind.startsWith("btcTransfer.")) return data.btcBalanceDocument.status
  return data.btcBalanceDocument.status
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (!value) throw new Error("useAppState must be used inside AppStateProvider")
  return value
}

/** AppShell also renders in isolated design-foundation tests without a provider. */
export function useOptionalAppState(): AppStateValue | null {
  return useContext(AppStateContext)
}

function readDisplayUnit(): DisplayUnit {
  if (typeof window === "undefined") return "btc"
  try {
    return displayUnitFromStorageKey(window.localStorage.getItem(DISPLAY_UNIT_STORAGE_KEY))
  } catch {
    return "btc"
  }
}

function readLedgerTheme(): LedgerTheme {
  if (typeof window === "undefined") return "dark"
  try {
    return window.localStorage.getItem(LEDGER_THEME_STORAGE_KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback
  try {
    const stored = window.localStorage.getItem(key)
    return stored === null ? fallback : stored === "true"
  } catch {
    return fallback
  }
}

function writePreference(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Appearance controls remain usable when storage is blocked.
  }
}

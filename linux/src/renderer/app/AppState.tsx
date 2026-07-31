// App-wide state: which profile is active, which route is showing, which month
// the money screens are reporting on, and the QA state override that lets every
// page be inspected in all five states.

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
import type { Freshness, MonthKey } from "@vogel-vault/domain/readModel"

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
  const [stateOverride, setStateOverride] = useState<StateOverride>(initialStateOverride)
  const [selectedMonth, setSelectedMonth] = useState<MonthKey | null>(initialSelectedMonth)
  const [displayUnit, setStoredDisplayUnit] = useState<DisplayUnit>(
    () => initialDisplayUnit ?? readDisplayUnit(),
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
    const bridge = window.vogelVault
    if (!bridge) return false
    let profileResult: Awaited<ReturnType<typeof bridge.setReadProfile>>
    try {
      profileResult = await bridge.setReadProfile(profile)
    } catch {
      profileResult = { status: "rejected" as const }
    }
    if (profileResult.status !== "active" || profileResult.profile !== profile) {
      if (generationRef.current === generation) {
        setRemoteFinance({ profile, model: ERROR_FINANCE_MODEL })
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
      loadConvexRowEnvelope(query, profile),
      loadLinuxFinanceReadModel(query),
    ])
    if (generationRef.current !== generation) return false
    setRemoteFinance({ profile, model: financeModel })
    if (result.status !== "loaded") return false
    setRemoteData({ profile, data: result.data, origin: "remote" })
    return financeReadSucceeded(financeModel)
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
          : buildSanitizedFixtureEnvelope(activeProfile)
        : fixtureEnvelopeInState(activeProfile, stateOverride),
    [activeProfile, remoteData, stateOverride],
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
      selectedMonth,
      selectMonth: setSelectedMonth,
      stateOverride,
      setStateOverride,
      displayUnit,
      setDisplayUnit,
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
      selectedMonth,
      stateOverride,
      displayUnit,
      setDisplayUnit,
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
  return data.btcBalanceDocument.status
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

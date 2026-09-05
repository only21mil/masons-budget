// Ledger motion helpers for the first wave: the hero numeral settle and the
// phosphor pulse. Both gate on the app's reduce-motion setting and on the
// system prefers-reduced-motion query; when either is on, values land at once.
//
// CSS transitions and keyframes carry their own gates through the
// --vv-ledger-motion-* tokens and the [data-vv-motion="off"] scope; this file
// only covers motion that has to be driven from JavaScript.

import { useEffect, useRef, useState } from "react"

import { useOptionalAppState } from "../app/AppState.tsx"

/** Hero numeral settle, matching --vv-ledger-motion-settle. */
export const SETTLE_MS = 300

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/** Cubic ease-out: fast start, gentle landing, no overshoot. */
export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress))
  return 1 - (1 - clamped) ** 3
}

/**
 * Interpolate two integer amounts (cents or sats) at an eased progress.
 * The arithmetic runs in doubles, which is exact for the magnitudes a ledger
 * displays, and the result is rounded back to an integer so the formatter
 * never sees a fraction of a cent.
 */
export function interpolateBigInt(from: bigint, to: bigint, progress: number): bigint {
  if (progress >= 1) return to
  if (progress <= 0) return from
  const eased = easeOutCubic(progress)
  return from + BigInt(Math.round(Number(to - from) * eased))
}

function systemPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** True when the app setting or the system preference asks for no motion. */
export function useReducedMotion(): boolean {
  const appSetting = useOptionalAppState()?.reduceMotionEnabled ?? false
  const [systemSetting, setSystemSetting] = useState(systemPrefersReducedMotion)

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    const update = () => setSystemSetting(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return appSetting || systemSetting
}

/**
 * Settle a numeric reading over SETTLE_MS with an ease-out curve.
 *
 * The first render prints the value cold; only a later change animates. A
 * null target (no reading) is shown immediately, and a change from null to a
 * value is also immediate because there is nothing to count from.
 */
export function useSettledNumber(target: bigint | null, durationMs = SETTLE_MS): bigint | null {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(target)
  // Mirrors `shown` so a retargeted settle counts on from wherever it was.
  // Written only inside the effect, never during render.
  const shownRef = useRef(target)

  useEffect(() => {
    const from = shownRef.current
    const show = (value: bigint | null) => {
      shownRef.current = value
      setShown(value)
    }
    if (target === null || from === null || reduced || from === target || durationMs <= 0) {
      show(target)
      return
    }
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      show(target)
      return
    }

    let frame = 0
    const started = performance.now()
    const step = (now: number) => {
      const progress = (now - started) / durationMs
      show(interpolateBigInt(from, target, progress))
      if (progress < 1) frame = window.requestAnimationFrame(step)
    }
    frame = window.requestAnimationFrame(step)
    return () => window.cancelAnimationFrame(frame)
  }, [target, reduced, durationMs])

  return shown
}

/**
 * One-shot pulse flag that turns on when a non-null reading changes to a
 * different non-null reading. The caller clears it on animationend, so the
 * pulse runs once per quote and never on a timer.
 */
export function usePulseOnChange(value: bigint | null): {
  readonly pulsing: boolean
  readonly endPulse: () => void
} {
  const reduced = useReducedMotion()
  const previous = useRef(value)
  const [pulsing, setPulsing] = useState(false)

  useEffect(() => {
    const last = previous.current
    previous.current = value
    if (reduced || value === null || last === null || last === value) return
    setPulsing(true)
  }, [value, reduced])

  return { pulsing, endPulse: () => setPulsing(false) }
}

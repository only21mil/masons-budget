import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"

/** A clock function is injected in tests; production uses the local system clock. */
export type TaskNow = () => Date

const systemNow: TaskNow = () => new Date()
const TaskClockContext = createContext<TaskNow>(systemNow)

/**
 * Format the user's local calendar day without converting through UTC.
 *
 * Todo due dates are calendar days, not instants. `toISOString()` can move a
 * late-evening local date into tomorrow (or an early-morning date into
 * yesterday), which would put the same task in different smart lists.
 */
export function localDateKey(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, "0")
  const month = (now.getMonth() + 1).toString().padStart(2, "0")
  const day = now.getDate().toString().padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Current local task day.
 *
 * Production schedules a refresh just after local midnight, so a long-running
 * desktop session cannot keep yesterday's Today and Upcoming boundaries.
 * Injected test clocks are deterministic and intentionally do not start timers.
 */
export function useTaskToday(): string {
  const now = useContext(TaskClockContext)
  const [today, setToday] = useState(() => localDateKey(now()))

  useEffect(() => {
    const observed = localDateKey(now())
    if (observed !== today) setToday(observed)
    if (now !== systemNow) return

    const current = now()
    const nextMidnight = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() + 1,
    )
    const delay = Math.max(1_000, nextMidnight.getTime() - current.getTime() + 100)
    const timer = globalThis.setTimeout(() => {
      setToday(localDateKey(now()))
    }, delay)
    return () => globalThis.clearTimeout(timer)
  }, [now, today])

  return today
}

/** Deterministic clock seam for renderer tests and future time-based QA. */
export function TaskClockProvider({
  now,
  children,
}: {
  now: TaskNow
  children?: ReactNode
}) {
  return <TaskClockContext.Provider value={now}>{children}</TaskClockContext.Provider>
}

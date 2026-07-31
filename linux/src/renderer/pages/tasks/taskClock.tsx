import { createContext, useContext, useEffect, useState } from "react"
import type { ReactNode } from "react"

/** A clock function is injected in tests; production uses the local system clock. */
export type TaskNow = () => Date

const systemNow: TaskNow = () => new Date()
const TaskClockContext = createContext<TaskNow>(systemNow)

/** Format a local calendar day without converting through UTC. */
export function localDateKey(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, "0")
  const month = (now.getMonth() + 1).toString().padStart(2, "0")
  const day = now.getDate().toString().padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Return the current local task day and refresh it just after local midnight.
 * Injected clocks stay deterministic and intentionally do not start timers.
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

/** Deterministic clock seam for renderer tests and screenshot fixtures. */
export function TaskClockProvider({
  now,
  children,
}: {
  now: TaskNow
  children?: ReactNode
}) {
  return <TaskClockContext.Provider value={now}>{children}</TaskClockContext.Provider>
}

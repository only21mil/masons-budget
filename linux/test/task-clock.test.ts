import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { TodoItem } from "@vogel-vault/domain/readModel"

import {
  TaskClockProvider,
  localDateKey,
  useTaskToday,
} from "../src/renderer/pages/tasks/taskClock.tsx"
import {
  taskFiltersFor,
  taskWriteStatusMessage,
} from "../src/renderer/pages/tasks/index.tsx"

function todo(due: string | null, done = false): TodoItem {
  return {
    id: "todo-clock",
    updatedAtMs: 1,
    title: "Clock boundary",
    done,
    flagged: false,
    project: "Inbox",
    area: null,
    due,
    notes: null,
    lane: null,
    priority: null,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    owner: "victor",
  }
}

function ClockProbe() {
  return createElement("span", null, useTaskToday())
}

describe("task clock", () => {
  it("formats the local calendar date without a UTC conversion", () => {
    expect(localDateKey(new Date(2027, 0, 2, 23, 59, 59))).toBe("2027-01-02")
    expect(localDateKey(new Date(2028, 1, 29, 0, 0, 0))).toBe("2028-02-29")
  })

  it("accepts an injected clock for deterministic renderer tests", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TaskClockProvider,
        { now: () => new Date(2031, 10, 9, 8, 0, 0) },
        createElement(ClockProbe),
      ),
    )
    expect(markup).toBe("<span>2031-11-09</span>")
  })

  it("pins today and upcoming boundaries to the supplied local day", () => {
    const filters = taskFiltersFor("2026-07-30")
    expect(filters.today(todo("2026-07-29"))).toBe(true)
    expect(filters.today(todo("2026-07-30"))).toBe(true)
    expect(filters.today(todo("2026-07-31"))).toBe(false)
    expect(filters.upcoming(todo("2026-07-31"))).toBe(true)
    expect(filters.upcoming(todo("2026-07-30"))).toBe(false)
    expect(filters.today(todo("2026-07-29", true))).toBe(false)
  })
})

describe("task write status", () => {
  it("does not show a limitation when edit and delete are both available", () => {
    expect(taskWriteStatusMessage(
      { allowed: true, reason: null },
      { allowed: true, reason: null },
    )).toBeNull()
  })

  it("names distinct edit and delete blockers", () => {
    expect(taskWriteStatusMessage(
      { allowed: true, reason: null },
      { allowed: false, reason: "Delete permission is missing." },
    )).toBe("Deleting tasks: Delete permission is missing.")
  })
})

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { renderToStaticMarkup } from "react-dom/server"
import { test } from "vitest"

import { AppShell } from "../src/renderer/components/AppShell.tsx"
import { PaymentRailGlyph } from "../src/renderer/components/LedgerFoundations.tsx"
import {
  ledgerAwards,
  moreCountLabel,
} from "../src/renderer/pages/admin/index.tsx"
import {
  activityMatchesFilter,
  paymentRailForCard,
} from "../src/renderer/pages/finance/index.tsx"
import { ALL_PAGES } from "../src/renderer/pages/index.ts"
import { todayLedgerTaskFilter } from "../src/renderer/pages/tasks/index.tsx"
import { liveEnvelope, renderRoute } from "./support/renderRoute.ts"

const here = dirname(fileURLToPath(import.meta.url))
const styles = readFileSync(join(here, "..", "src", "renderer", "styles", "components.css"), "utf8")

test("the shell adopts the ledger theme, route scope, Horizon wordmark, and inert texture", () => {
  const markup = renderToStaticMarkup(
    <AppShell sections={[]} activeId="dashboard" onNavigate={() => {}} topBar={null}>
      ledger
    </AppShell>,
  )

  assert.match(markup, /data-vv-theme="dark"/)
  assert.match(markup, /data-vv-route="dashboard"/)
  assert.match(markup, /SOVEREIGN/)
  assert.match(markup, /BUDGET APP/)
  assert.match(markup, /vv-ledger-scanlines/)
  assert.match(markup, /aria-hidden="true"/)
  assert.match(styles, /--vv-sidebar-width: 130px/)
  assert.match(styles, /var\(--vv-ledger-rule-style\)/)
  assert.match(styles, /font-family: var\(--vv-ledger-font\)/)
})

test("Activity maps only exact card-wire rails to the accepted Bolt and Chain glyphs", () => {
  assert.equal(paymentRailForCard("lightning"), "lightning")
  assert.equal(paymentRailForCard("zeus_lightning"), "lightning")
  assert.equal(paymentRailForCard("on_chain"), "on-chain")
  assert.equal(paymentRailForCard("zeus_on_chain"), "on-chain")
  assert.equal(paymentRailForCard("coinbase_card"), null)
  assert.equal(paymentRailForCard(null), null)

  const bolt = renderToStaticMarkup(<PaymentRailGlyph rail="lightning" title="Lightning payment" />)
  const chain = renderToStaticMarkup(<PaymentRailGlyph rail="on-chain" title="On-chain payment" />)
  assert.match(bolt, /M13 3 5 13h6l-1 8 8-10h-6l1-8z/)
  assert.match(chain, /<rect x="3" y="8" width="7" height="8" rx="1.5"><\/rect>/)

  const data = liveEnvelope()
  const rows = data.transactions.value
  const activity = renderRoute("activity", "victor", {
    ...data,
    transactions: {
      ...data.transactions,
      value: [
        { ...rows[0]!, card: "zeus_lightning" },
        { ...rows[1]!, card: "zeus_on_chain" },
      ],
    },
  })
  assert.match(activity, /Lightning payment/)
  assert.match(activity, /On-chain payment/)
  assert.match(activity, /lightning/i)
  assert.match(activity, /on-chain/i)
  assert.ok(activityMatchesFilter({ ...rows[0]!, card: "zeus_lightning" }, "lightning"))
  assert.ok(!activityMatchesFilter({ ...rows[0]!, card: "Debit" }, "lightning"))
})

test("Today retains completed due rows and joins them with scoped money out", () => {
  const data = liveEnvelope()
  const completed = {
    ...data.todos.value[0]!,
    id: "todo-complete-today",
    owner: "victor" as const,
    title: "Completed today proof",
    due: "2026-07-26",
    done: true,
  }
  const todaySpend = {
    ...data.transactions.value[0]!,
    id: "tx-money-out-today",
    owner: "victor" as const,
    date: "2026-07-26",
    merchant: "Today proof merchant",
  }
  const markup = renderRoute("today", "victor", {
    ...data,
    todos: { ...data.todos, value: [completed] },
    transactions: { ...data.transactions, value: [todaySpend] },
  })

  assert.ok(todayLedgerTaskFilter("2026-07-26")(completed))
  assert.match(markup, /Due today or overdue, including completed tasks/)
  assert.match(markup, /Completed today proof/)
  assert.match(markup, /vv-task-complete/)
  assert.match(markup, /Money out today/)
  assert.match(markup, /Today proof merchant/)
})

test("Family, Settings, onboarding, Awards, Tasks, and More close the packet gaps", () => {
  for (const route of ["tasks", "awards", "more"]) {
    assert.ok(ALL_PAGES.some((page) => page.id === route), `${route} route is missing`)
  }

  const family = renderRoute("family")
  assert.match(family, /Profiles and what each one sees/i)
  assert.match(family, /How scoping works/)
  assert.match(family, /Active profile only/)
  assert.equal((family.match(/vv-family-card/g) ?? []).length >= 4, true)

  const settings = renderRoute("settings")
  for (const copy of [
    "Appearance",
    "Behaviour",
    "Budget alerts",
    "Phosphor glow",
    "Scanlines",
    "Biometric unlock",
    "Replay onboarding",
  ]) assert.match(settings, new RegExp(copy, "i"))
  assert.equal((settings.match(/role="switch"/g) ?? []).length, 4)

  const onboarding = renderRoute("onboarding")
  assert.match(onboarding, /STEP 01 \/ 03/)
  assert.match(onboarding, /Everything in BTC, sats, or dollars/)
  assert.match(onboarding, /aria-label="Step 1 of 3"/)
  assert.equal((onboarding.match(/vv-onboarding__progress/g) ?? []).length, 1)

  const more = renderRoute("more")
  for (const copy of ["BTC Buys", "BTC Bill Pays", "Net Worth", "Retirement", "Today", "Tasks", "Family", "Settings", "Awards"]) {
    assert.match(more, new RegExp(copy))
  }
  assert.doesNotMatch(more, /Export/)

  assert.equal(moreCountLabel(0), "")
  assert.equal(moreCountLabel(8), "8")
  assert.equal(moreCountLabel(1_000), "999+")

  const awards = ledgerAwards(1, 1, 1)
  assert.deepEqual(
    awards.map(({ title, earned }) => [title, earned]),
    [
      ["First entry", true],
      ["Stacking", true],
      ["Clear the board", true],
      ["Ten clean closes", false],
    ],
  )
  const awardMarkup = renderRoute("awards")
  assert.match(awardMarkup, /First entry/)
  assert.match(awardMarkup, /Ten clean closes/)
  assert.match(awardMarkup, /Earned/)
  assert.match(awardMarkup, /Locked/)
})

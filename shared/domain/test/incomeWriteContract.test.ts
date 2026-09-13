import assert from "node:assert/strict"
import test from "node:test"
import { buildIncomeWriteRequest, buildIncomeDeleteRequest } from "../src/incomeWriteContract.ts"
import { encodeConvexInt64 } from "../src/convexInt64.ts"
const input = (owner = "victor") => ({ owner, sourceFile: "income", income: { id: "pay-1", owner, date: "2026-09-13", amountCents: "9223372036854775807", source: "Employer" } })
test("standalone income keeps exact int64 wire values and canonicalizes adults", () => {
  const request = buildIncomeWriteRequest("rachel", input("rachel"))
  assert.equal(request.path, "tables:upsertIncomeFromDevice")
  assert.equal(request.args.owner, "victor")
  assert.equal(request.args.income.owner, "victor")
  assert.deepEqual(request.args.income.amountCents, encodeConvexInt64(9223372036854775807n))
  assert.equal("deviceToken" in request.args, false)
})
test("children write only their own income", () => {
  for (const owner of ["mason", "maddox"]) {
    assert.equal(buildIncomeWriteRequest(owner, input(owner)).args.owner, owner)
    for (const other of ["victor", "rachel", "mason", "maddox"].filter((value) => value !== owner)) {
      assert.throws(() => buildIncomeWriteRequest(owner, input(other)))
    }
  }
})
test("rejects invalid identity, dates, amounts, source and owner", () => {
  for (const patch of [{ id: "" }, { date: "2026-02-30" }, { amountCents: "0" }, { amountCents: "-1" }, { amountCents: "9223372036854775808" }, { source: "" }, { owner: "mason" }]) {
    assert.throws(() => buildIncomeWriteRequest("victor", { ...input(), income: { ...input().income, ...patch } }))
  }
})
test("deletes require a real read revision and preserve the actor's scope", () => {
  const candidate = { owner: "rachel", sourceFile: "income", entityId: "pay-1", baseUpdatedAtMs: 123 }
  assert.deepEqual(buildIncomeDeleteRequest("rachel", candidate).args, { ...candidate, owner: "victor" })
  for (const baseUpdatedAtMs of [undefined, -1, 0.5, Number.NaN]) {
    assert.throws(() => buildIncomeDeleteRequest("rachel", { ...candidate, baseUpdatedAtMs }))
  }
  assert.throws(() => buildIncomeDeleteRequest("mason", candidate))
})

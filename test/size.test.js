import { test } from "node:test"
import assert from "node:assert/strict"
import { MAX_BYTES, cost, fit, trimValue } from "../size.js"

test("small replies are untouched", () => {
  const obj = { found: 2, hits: [{ a: 1 }, { b: 2 }] }
  assert.equal(fit(obj, "hits"), obj)
})

test("a long list keeps its head and says how many went", () => {
  const out = fit({ found: 5000, hits: Array.from({ length: 5000 }, (_, i) => ({ i, s: "x".repeat(50) })) }, "hits")
  assert.ok(cost(out) <= MAX_BYTES)
  assert.equal(out.hits[0].i, 0)
  assert.equal(out.hits.length + out.omitted, 5000)
})

test("an oversized item is shortened, and later items still fit", () => {
  const out = fit({ results: [{ big: "y".repeat(60000) }, ...Array.from({ length: 6 }, (_, i) => ({ i }))] }, "results")
  assert.ok(cost(out) <= MAX_BYTES)
  assert.equal(out.results.length, 7)
  assert.match(out.results[0].big, /\[cut \d+ characters\]$/)
  assert.equal(out.omitted, undefined)
})

test("nested lists are cut where they are, keeping the rest of the item", () => {
  const item = { profile: { name: "keep me", extra: { list: Array.from({ length: 3000 }, (_, i) => ({ i, t: "z".repeat(30) })) } } }
  const out = fit({ results: [item] }, "results")
  assert.ok(cost(out) <= MAX_BYTES)
  assert.equal(out.results[0].profile.name, "keep me")
  assert.match(out.results[0].profile.extra.list.at(-1), /^\[\d+ more not shown\]$/)
})

test("a single item that fits the budget whole isn't cut to half", () => {
  const item = { bio: "b".repeat(26000), snapshots: Array.from({ length: 50 }, () => "s".repeat(300)) }
  const out = fit({ results: [item], found: 1 }, "results")
  assert.deepEqual(out.results[0], item)
})

test("the budget counts bytes, so CJK text can't blow the token limit", () => {
  const out = fit({ hits: Array.from({ length: 4000 }, (_, i) => ({ name: "王小明" + i })) }, "hits")
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES)
  assert.ok(out.omitted > 0)
})

test("trimValue always ends, even for tiny budgets", () => {
  for (const budget of [0, 5, 50]) {
    trimValue("x".repeat(1000), budget)
    trimValue(Array.from({ length: 100 }, () => ({ a: "b".repeat(100) })), budget)
    trimValue({ a: { b: { c: "d".repeat(1000) } } }, budget)
  }
})

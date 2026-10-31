import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const KEY = "a".repeat(48)
const seen = []
let api, client

const lines = (res, list, gap = 5) => {
  res.writeHead(200, { "content-type": "application/x-ndjson" })
  let i = 0
  const next = () => (i < list.length ? (res.write(JSON.stringify(list[i++]) + "\n"), setTimeout(next, gap)) : res.end())
  next()
}

before(async () => {
  api = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}")
      seen.push({ path: req.url, key: req.headers["x-api-key"], body })
      if (req.headers["x-api-key"] !== KEY) return res.writeHead(401).end(JSON.stringify({ error: "Invalid API key" }))
      if (req.url === "/search" && body.identifier === "broke@example.com") return res.writeHead(402).end(JSON.stringify({ error: "No searches remaining" }))
      if (req.url === "/search" && body.identifier === "drop@example.com") {
        res.writeHead(200); res.write(JSON.stringify({ totalModules: 3 }) + "\n")
        res.write(JSON.stringify({ className: "gravataremail", result: { show: { username: "drop" } } }) + "\n")
        return setTimeout(() => res.socket.destroy(), 50)
      }
      if (req.url === "/search" && body.identifier === "lastgasp@example.com") {
        res.writeHead(200)
        return res.end([{ totalModules: 1 }, { progress: 0.9 }].map((l) => JSON.stringify(l)).join("\n") + "\n")
      }
      if (req.url === "/search" && body.identifier === "keepalive@example.com") {
        res.writeHead(200); res.write(JSON.stringify({ totalModules: 2 }) + "\n" + JSON.stringify({ progress: 0.5 }) + "\n")
        setTimeout(() => res.write(JSON.stringify({ progress: 0.5 }) + "\n"), 1100)
        setTimeout(() => res.write(JSON.stringify({ progress: 0.8 }) + "\n"), 2200)
        return setTimeout(() => res.end(JSON.stringify({ progress: 1 }) + "\n"), 2300)
      }
      if (req.url === "/steam/lookup" && body.query === "slowtool") {
        res.writeHead(200); return res.write(JSON.stringify({ type: "meta", total: 1, pending: true }) + "\n")
      }
      if (req.url === "/twitter/search") return lines(res, [
        { type: "meta", total: 1 },
        { type: "result", data: { profile: { username: "long" }, pass: "123.sig", snapshots: Array.from({ length: 5000 }, (_, i) => ({ i, bio: "x".repeat(40) })) } },
        { type: "done", total: 1 },
      ], 0)
      if (req.url === "/microsoft/search") return lines(res, [
        { type: "meta", total: 500 },
        ...Array.from({ length: 500 }, (_, i) => ({ type: "result", data: { show: { id: String(i), name: "N" + i, empty: "" }, full: { blob: "y".repeat(2000) } } })),
        { type: "done", total: 500 },
      ], 0)
      if (req.url === "/search" && body.identifier === "odd@example.com") return lines(res, [
        { totalModules: 4 },
        { className: "strangeemail", result: { show: "just text" } },
        { className: "sneakyemail", result: { show: { source: "evil", name: "N" } } },
        { className: "bigemail", result: { show: { bio: "z".repeat(70000) } } },
        { className: "smallemail", result: { show: { name: "small" } } },
      ].map((l) => l).concat([{ progress: 1 }]), 0)
      if (req.url === "/search" && body.identifier === "garbled@example.com") {
        res.writeHead(200)
        return res.end(JSON.stringify({ totalModules: 1 }) + "\n{not json\n" + JSON.stringify({ progress: 1 }) + "\n")
      }
      if (req.url === "/epic/search" && body.query === "partial") return lines(res, [
        { type: "meta", total: 2 },
        { type: "result", data: { show: { username: "a" }, full: {} } },
        { type: "done", total: 1, error: { code: "upstream" } },
      ])
      if (req.url === "/tiktok/search") return res.writeHead(404).end("Cannot POST /tiktok/search")
      if (req.url === "/search" && body.identifier === "slow@example.com") {
        res.writeHead(200); res.write(JSON.stringify({ totalModules: 3 }) + "\n")
        res.write(JSON.stringify({ className: "Gravatar", result: { show: { username: "slow" } } }) + "\n")
        return // never ends
      }
      if (req.url === "/search") return lines(res, [
        { totalModules: 3 },
        { className: "Gravatar", result: { show: { username: "riverhale", name: "River Hale", bio: "", photos: [] } } },
        { progress: 1 / 3 },
        { fastComplete: true },
        { className: "githubusername", result: { show: { username: "riverhale", location: "Portland, OR" } } },
        { progress: 2 / 3 },
        { progress: 1 },
      ])
      if (req.url === "/google/search") return lines(res, [
        { type: "meta", total: 1, usage: { credits: 9 } },
        { type: "result", data: { gaiaId: "123", name: "River Hale" } },
        { type: "done", total: 1, usage: { credits: 9 } },
      ])
      if (req.url === "/steam/lookup") return lines(res, [{ type: "meta", total: 0 }, { type: "done", total: 0, error: "Profile not found" }])
      if (req.url === "/instagram/search") return res.writeHead(404).end(JSON.stringify({ error: "No sharer found", usage: { used: 0 } }))
      res.writeHead(404).end(JSON.stringify({ error: "Not found" }))
    })
  })
  await new Promise((r) => api.listen(0, "127.0.0.1", r))
  client = new Client({ name: "test", version: "1" })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.js", import.meta.url).pathname],
    env: { ...process.env, OSINTSX_API_KEY: KEY, OSINTSX_API_URL: `http://127.0.0.1:${api.address().port}` },
  }))
})
// Node 20.3 skips after() while handles are open, so the last test closes them.
let closed = false
async function teardown() {
  if (closed) return
  closed = true
  await client?.close()
  api?.close()
}
after(teardown)

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args })
  return { ...r, json: (() => { try { return JSON.parse(r.content[0].text) } catch { return null } })() }
}

test("lists every tool, all read-only", async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "epic_games_lookup", "google_account_lookup", "instagram_share_trace", "microsoft_account_lookup",
    "search", "steam_history", "tiktok_share_trace", "twitter_history",
  ])
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name)
    assert.match(t.description, /credit/, `${t.name} says what it costs`)
  }
})

test("search collects hits, drops empty fields, sends the right body", async () => {
  const r = await call("search", { type: "email", identifier: "river.hale@example.com" })
  assert.equal(r.isError, undefined)
  assert.equal(r.json.found, 2)
  assert.equal(r.json.complete, true)
  assert.equal(r.json.sources, 3)
  assert.deepEqual(r.json.hits[0], { source: "Gravatar", username: "riverhale", name: "River Hale" })
  assert.equal(r.json.hits[1].source, "Github")
  const req = seen.findLast((s) => s.path === "/search")
  assert.deepEqual(req.body, { moduleType: "email", identifier: "river.hale@example.com", alertMode: false })
  assert.equal(req.key, KEY)
})

test("search returns what it has at the time limit", async () => {
  const r = await call("search", { type: "email", identifier: "slow@example.com", max_wait_seconds: 10 })
  assert.equal(r.json.complete, false)
  assert.equal(r.json.found, 1)
  assert.match(r.json.note, /time limit/)
})

test("an API refusal comes back as a readable tool error", async () => {
  const r = await call("search", { type: "email", identifier: "broke@example.com" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /402: No searches remaining\. No credits left\. Buy more at https:\/\/osint\.sx\/pay/)
})

test("tools map arguments and return results with usage", async () => {
  const r = await call("google_account_lookup", { query_type: "email", query: "river.hale@example.com" })
  assert.deepEqual(r.json.results, [{ gaiaId: "123", name: "River Hale" }])
  assert.deepEqual(r.json.usage, { credits: 9 })
  assert.deepEqual(seen.findLast((s) => s.path === "/google/search").body, { queryType: "email", query: "river.hale@example.com" })
})

test("a tool's done-with-error is an error that says nothing was charged", async () => {
  const r = await call("steam_history", { query: "nobody" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Profile not found \(no credit was charged\)/)
})

test("a share trace with no sharer is an answer, not an error", async () => {
  const r = await call("instagram_share_trace", { url: "https://www.instagram.com/p/x/?igsh=abc" })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /^The trace didn't find a sharer: No sharer found\. No credit was charged\.$/)
})

test("a dropped connection keeps the hits that arrived", async () => {
  const r = await call("search", { type: "email", identifier: "drop@example.com" })
  assert.equal(r.isError, undefined)
  assert.equal(r.json.found, 1)
  assert.equal(r.json.complete, false)
  assert.match(r.json.note, /connection dropped/)
})

test("a progress update sent just before the result still reaches the client", async () => {
  const seen = []
  const errors = []
  client.onerror = (e) => errors.push(e.message)
  await client.callTool({ name: "search", arguments: { type: "email", identifier: "lastgasp@example.com" } }, undefined, { onprogress: (p) => seen.push(p.progress) })
  client.onerror = undefined
  assert.deepEqual(seen, [0.9])
  assert.deepEqual(errors.filter((m) => /unknown token/.test(m)), [])
})

test("progress only rises, though the API repeats a value", async () => {
  const seenProgress = []
  await client.callTool({ name: "search", arguments: { type: "email", identifier: "keepalive@example.com" } }, undefined, { onprogress: (p) => seenProgress.push(p.progress) })
  assert.deepEqual(seenProgress, [0.5, 0.8])
})

test("a tool cut off by the time limit says the credit may be spent", async () => {
  const r = await call("steam_history", { query: "slowtool", max_wait_seconds: 10 })
  assert.equal(r.isError, undefined)
  assert.equal(r.json.found, 0)
  assert.match(r.json.note, /time limit before the tool finished, with 1 result\(s\) expected\. The credit may already have been used/)
})

test("a 404 without the trace's reason is an error, not 'no sharer'", async () => {
  const r = await call("tiktok_share_trace", { url: "https://vm.tiktok.com/abc/" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /^404: /)
})

test("a malformed key is refused before any request, and never echoed", async () => {
  const bad = new Client({ name: "bad", version: "1" })
  await bad.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.js", import.meta.url).pathname],
    env: { ...process.env, OSINTSX_API_KEY: "secret\u0007value", OSINTSX_API_URL: `http://127.0.0.1:${api.address().port}` },
  }))
  const before = seen.length
  const r = await bad.callTool({ name: "search", arguments: { type: "email", identifier: "a@example.com" } })
  await bad.close()
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /isn't a valid key/)
  assert.doesNotMatch(r.content[0].text, /secret/)
  assert.equal(seen.length, before)
})

test("tool results keep the card fields unless raw is asked for", async () => {
  const r = await call("microsoft_account_lookup", { query_type: "name", query: "n" })
  assert.deepEqual(r.json.results[0], { id: "0", name: "N0" })
  assert.equal(r.json.found, 500)
  assert.ok(r.content[0].text.length <= 48000)
  const raw = await call("microsoft_account_lookup", { query_type: "name", query: "n", include_raw: true })
  assert.ok(raw.json.results[0].full)
  assert.ok(raw.content[0].text.length <= 48000)
  assert.equal(raw.json.results.length + raw.json.omitted, 500)
})

test("one huge result is shortened, not dropped, and internal fields go", async () => {
  const r = await call("twitter_history", { query_type: "username", query: "long" })
  const item = r.json.results[0]
  assert.equal(item.profile.username, "long")
  assert.equal(item.pass, undefined)
  const marker = item.snapshots.at(-1)
  const more = Number(/^\[(\d+) more not shown\]$/.exec(marker)?.[1])
  assert.ok(item.snapshots.length > 1 && item.snapshots.length < 5000)
  assert.equal(item.snapshots.length - 1 + more, 5000)
  assert.ok(r.content[0].text.length <= 48000)
})

test("odd hit shapes: non-object show, a 'source' field, one huge hit", async () => {
  const r = await call("search", { type: "email", identifier: "odd@example.com" })
  const by = Object.fromEntries(r.json.hits.map((h) => [h.source, h]))
  assert.deepEqual(by.Strange, { value: "just text", source: "Strange" })
  assert.equal(by.Sneaky.name, "N")
  assert.equal(by.Sneaky.source, "Sneaky")
  assert.equal(by.Small.name, "small", "a small hit after a huge one is kept")
  assert.match(by.Big.bio, /\[cut \d+ characters\]$/)
  assert.equal(r.json.found, 4)
  assert.ok(Buffer.byteLength(r.content[0].text) <= 48000)
})

test("unreadable API lines are counted in a note", async () => {
  const r = await call("search", { type: "email", identifier: "garbled@example.com" })
  assert.match(r.json.note, /1 line\(s\) from the API couldn't be read/)
})

test("a tool error after some results is kept as a note, and objects print as JSON", async () => {
  const r = await call("epic_games_lookup", { query_type: "username", query: "partial" })
  assert.equal(r.isError, undefined)
  assert.deepEqual(r.json.results, [{ username: "a" }])
  assert.match(r.json.note, /The tool also reported: \{"code":"upstream"\}/)
})

test("include_raw is offered exactly where results carry raw data", async () => {
  const { tools } = await client.listTools()
  const has = Object.fromEntries(tools.map((t) => [t.name, "include_raw" in (t.inputSchema.properties || {})]))
  assert.deepEqual(Object.keys(has).filter((k) => has[k]).sort(), ["epic_games_lookup", "google_account_lookup", "instagram_share_trace", "microsoft_account_lookup", "tiktok_share_trace"])
})

test("bad arguments are refused before any request", async () => {
  const before = seen.length
  const r = await call("search", { type: "fax", identifier: "x" }).catch((e) => ({ isError: true, content: [{ text: e.message }] }))
  assert.equal(r.isError, true)
  assert.equal(seen.length, before)
})

test("teardown", teardown)

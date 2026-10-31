import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const KEY = "b".repeat(48)
const SERVER = new URL("../index.js", import.meta.url).pathname
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
const requests = []
const closedEarly = []
const outputs = [] // every tool output text, checked for the key at the end
let api, client, base

async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return check()
}

const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))

before(async () => {
  api = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(raw || "{}") } catch {}
      requests.push({ path: req.url, body })
      const mode = body.identifier ?? body.query ?? body.url
      res.on("close", () => { if (!res.writableEnded) closedEarly.push(mode) })

      const status = /^status-(\d{3})$/.exec(String(mode))
      if (status) return json(res, Number(status[1]), { error: `Reason ${status[1]}` })
      if (mode === "nosharer") return json(res, 404, { error: "This link has no sharer", usage: { used: 0 } })
      if (mode === "big-400") return json(res, 400, { error: "e".repeat(200000) })
      if (mode === "big-done") return res.writeHead(200).end(JSON.stringify({ type: "done", total: 0, error: "d".repeat(200000) }) + "\n")
      if (mode === "big-note") return res.writeHead(200).end([{ type: "result", data: { a: 1 } }, { type: "done", total: 1, error: "n".repeat(200000) }].map((l) => JSON.stringify(l)).join("\n") + "\n")
      if (mode === "tool-drop") {
        res.writeHead(200)
        res.write([{ type: "meta", total: 2 }, { type: "result", data: { a: 1 } }].map((l) => JSON.stringify(l)).join("\n") + "\n")
        return setTimeout(() => res.socket.destroy(), 50)
      }
      if (mode === "no-done") return res.writeHead(200).end([{ type: "meta", total: 2 }, { type: "result", data: { a: 1 } }].map((l) => JSON.stringify(l)).join("\n") + "\n")
      if (mode === "with-full") return res.writeHead(200).end([{ type: "meta", total: 1 }, { type: "result", data: { show: { id: "1" }, full: { follower_count: 5 } } }, { type: "done", total: 1 }].map((l) => JSON.stringify(l)).join("\n") + "\n")
      if (mode === "upstream-403") return json(res, 403, { error: "Upstream lookup failed" })
      if (mode === "html-500") return res.writeHead(500, { "content-type": "text/html" }).end("<html>Bad gateway</html>")
      if (mode === "empty-502") return res.writeHead(502).end()
      if (mode === "empty-200") return res.writeHead(200).end()
      if (mode === "hang" || mode === "hang-cancel" || mode === "hang-cancel-tool") return res.writeHead(200).write(JSON.stringify({ totalModules: 1 }) + "\n")
      if (mode === "split-utf8") {
        res.writeHead(200)
        const line = Buffer.from(JSON.stringify({ className: "unicodeemail", result: { show: { name: "Zoë 王 🎉" } } }) + "\n")
        const cut = line.indexOf(Buffer.from("🎉")) + 2 // inside the emoji
        res.write(line.subarray(0, cut))
        return setTimeout(() => res.end(Buffer.concat([line.subarray(cut), Buffer.from(JSON.stringify({ progress: 1 }) + "\n")])), 30)
      }
      if (mode?.startsWith?.("par-")) {
        res.writeHead(200)
        return setTimeout(() => res.end([{ totalModules: 1 }, { className: `${mode}email`, result: { show: { tag: mode } } }, { progress: 1 }].map((l) => JSON.stringify(l)).join("\n") + "\n"), 100)
      }
      if (req.url === "/search") return res.writeHead(200).end(JSON.stringify({ totalModules: 1 }) + "\n" + JSON.stringify({ progress: 1 }) + "\n")
      res.writeHead(200).end([{ type: "meta", total: 0 }, { type: "done", total: 0 }].map((l) => JSON.stringify(l)).join("\n") + "\n")
    })
  })
  await new Promise((r) => api.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${api.address().port}`
  client = await connect({ OSINTSX_API_KEY: KEY, OSINTSX_API_URL: base })
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

async function connect(env) {
  const c = new Client({ name: "test", version: "1" })
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, ...env } }))
  return c
}
async function call(name, args, opts, c = client) {
  try {
    const r = await c.callTool({ name, arguments: args }, undefined, opts)
    outputs.push(r.content.map((x) => x.text).join("\n"))
    let parsed = null
    try { parsed = JSON.parse(r.content[0].text) } catch {}
    return { ...r, json: parsed }
  } catch (e) {
    outputs.push(e.message)
    return { thrown: e }
  }
}
const last = () => requests.at(-1)

test("initialize names the server and the package version", () => {
  assert.equal(client.getServerVersion().name, "osintsx")
  assert.equal(client.getServerVersion().version, PKG.version)
})

test("every tool has a title, a cost, readOnly, and an object schema", async () => {
  const { tools } = await client.listTools()
  assert.equal(tools.length, 8)
  for (const t of tools) {
    assert.ok(t.title, t.name)
    assert.match(t.description, /credit/, t.name)
    assert.equal(t.annotations.readOnlyHint, true, t.name)
    assert.equal(t.inputSchema.type, "object", t.name)
    assert.ok(Object.keys(t.inputSchema.properties).length > 0, t.name)
  }
})

const VALID = [
  ["search", { type: "email", identifier: "a@example.com" }, "/search", { moduleType: "email", identifier: "a@example.com", alertMode: false }],
  ["search", { type: "phone", identifier: "+14155550123", include_alerting_sources: true }, "/search", { moduleType: "phone", identifier: "+14155550123", alertMode: true }],
  ["google_account_lookup", { query_type: "gaiaId", query: "123" }, "/google/search", { queryType: "gaiaId", query: "123" }],
  ["microsoft_account_lookup", { query_type: "cid", query: "abc" }, "/microsoft/search", { queryType: "cid", query: "abc" }],
  ["epic_games_lookup", { query_type: "platform", query: "x", platform: "psn" }, "/epic/search", { queryType: "platform", query: "x", platform: "psn" }],
  ["epic_games_lookup", { query_type: "accountId", query: "id" }, "/epic/search", { queryType: "accountId", query: "id" }],
  ["twitter_history", { query_type: "user_id", query: "12" }, "/twitter/search", { queryType: "user_id", query: "12" }],
  ["steam_history", { query: "gaben" }, "/steam/lookup", { query: "gaben" }],
  ["instagram_share_trace", { url: "https://www.instagram.com/p/x/?igsh=1" }, "/instagram/search", { url: "https://www.instagram.com/p/x/?igsh=1" }],
  ["tiktok_share_trace", { url: "https://vm.tiktok.com/x/" }, "/tiktok/search", { url: "https://vm.tiktok.com/x/" }],
]
for (const [name, args, path, body] of VALID) {
  test(`${name} ${JSON.stringify(args)} sends the documented body`, async () => {
    const r = await call(name, args)
    assert.equal(r.content?.[0]?.type, "text")
    assert.equal(r.isError, undefined, r.content?.[0]?.text)
    assert.equal(last().path, path)
    assert.deepEqual(last().body, body)
  })
}

test("unknown extra arguments never reach the API", async () => {
  await call("steam_history", { query: "gaben", surprise: "x", __proto__x: 1 })
  assert.deepEqual(last().body, { query: "gaben" })
})

const REFUSED = [
  ["search", { type: "fax", identifier: "a" }],
  ["search", { type: "email", identifier: 5 }],
  ["search", { type: "email" }],
  ["search", { type: "email", identifier: "" }],
  ["search", { type: "email", identifier: "x".repeat(257) }],
  ["search", { type: "email", identifier: "a@b.c", max_wait_seconds: 5 }],
  ["search", { type: "email", identifier: "a@b.c", max_wait_seconds: 601 }],
  ["search", { type: "email", identifier: "a@b.c", max_wait_seconds: 12.5 }],
  ["epic_games_lookup", { query_type: "username", query: "x".repeat(129) }],
  ["epic_games_lookup", { query_type: "platform", query: "x", platform: "sega" }],
  ["google_account_lookup", { query_type: "phone", query: "x" }],
  ["google_account_lookup", { query_type: "email", query: "x".repeat(257) }],
  ["microsoft_account_lookup", { query_type: "gaiaId", query: "x" }],
  ["twitter_history", { query_type: "username", query: "x".repeat(501) }],
  ["steam_history", { query: "x".repeat(501) }],
  ["steam_history", {}],
  ["instagram_share_trace", { url: "x".repeat(2049) }],
  ["tiktok_share_trace", { url: "" }],
  ["nonexistent_tool", {}],
]
for (const [name, args] of REFUSED) {
  test(`refused before any request: ${name} ${JSON.stringify(args).slice(0, 60)}`, async () => {
    const before = requests.length
    const r = await call(name, args)
    assert.ok(r.thrown || r.isError, "refused")
    assert.equal(requests.length, before, "no request sent")
  })
}

test("the longest allowed inputs are accepted", async () => {
  for (const [name, args] of [
    ["search", { type: "name", identifier: "x".repeat(256) }],
    ["epic_games_lookup", { query_type: "username", query: "x".repeat(128) }],
    ["twitter_history", { query_type: "url", query: "x".repeat(500) }],
    ["steam_history", { query: "x".repeat(500) }],
    ["instagram_share_trace", { url: "x".repeat(2048) }],
  ]) {
    const r = await call(name, args)
    assert.equal(r.isError, undefined, name)
  }
})

for (const s of [400, 401, 402, 403, 404, 429, 502, 503]) {
  test(`status ${s} is a readable error with the API's reason`, async () => {
    const r = await call("search", { type: "username", identifier: `status-${s}` })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, new RegExp(`^${s}: Reason ${s}\\.`))
  })
}

test("a share trace 404 with a reason and usage is an answer, not an error", async () => {
  const r = await call("tiktok_share_trace", { url: "nosharer" })
  assert.equal(r.isError, undefined)
  assert.match(r.content[0].text, /^The trace didn't find a sharer: This link has no sharer\. No credit was charged\.$/)
})

test("any other 404 on a share trace is an error, not 'no sharer'", async () => {
  const r = await call("instagram_share_trace", { url: "status-404" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /^404: Reason 404\./)
})

test("an upstream failure passed through isn't blamed on the account", async () => {
  const r = await call("twitter_history", { query_type: "username", query: "upstream-403" })
  assert.equal(r.isError, true)
  assert.equal(r.content[0].text, "403: Upstream lookup failed.")
})

test("error bodies that aren't JSON still read clearly", async () => {
  const html = await call("search", { type: "username", identifier: "html-500" })
  assert.equal(html.isError, true)
  assert.match(html.content[0].text, /^500: /)
  assert.doesNotMatch(html.content[0].text, /<html>/)
  const empty = await call("google_account_lookup", { query_type: "email", query: "empty-502" })
  assert.equal(empty.isError, true)
  assert.match(empty.content[0].text, /^502: /)
})

test("a refused connection and an unknown host are readable errors", async () => {
  // fetch refuses port 1, so use a port that was just freed.
  const probe = http.createServer()
  await new Promise((r) => probe.listen(0, "127.0.0.1", r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  for (const [url, expect] of [[`http://127.0.0.1:${port}`, new RegExp(`^Couldn't reach http://127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)\\.$`)], ["http://nothing-here.invalid", /^Couldn't reach http:\/\/nothing-here\.invalid/]]) {
    const c = await connect({ OSINTSX_API_KEY: KEY, OSINTSX_API_URL: url })
    const r = await call("search", { type: "email", identifier: "a@example.com" }, undefined, c)
    await c.close()
    assert.equal(r.isError, true, url)
    assert.match(r.content[0].text, expect)
  }
})

test("credentials in the API URL are refused clearly and never echoed", async () => {
  const c = await connect({ OSINTSX_API_KEY: KEY, OSINTSX_API_URL: base.replace("http://", "http://user:hunter2@") })
  const before = requests.length
  const r = await call("search", { type: "email", identifier: "a@example.com" }, undefined, c)
  await c.close()
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /can't contain a username or password/)
  assert.doesNotMatch(r.content[0].text, /hunter2/)
  assert.equal(requests.length, before)
})

test("an Epic platform search without a platform is refused before any request", async () => {
  const before = requests.length
  const r = await call("epic_games_lookup", { query_type: "platform", query: "someone" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Set platform/)
  assert.equal(requests.length, before)
})

test("the remaining length limits, both sides", async () => {
  for (const [name, args, ok] of [
    ["microsoft_account_lookup", { query_type: "name", query: "x".repeat(256) }, true],
    ["microsoft_account_lookup", { query_type: "name", query: "x".repeat(257) }, false],
    ["google_account_lookup", { query_type: "name", query: "x".repeat(256) }, true],
    ["tiktok_share_trace", { url: "x".repeat(2048) }, true],
    ["tiktok_share_trace", { url: "x".repeat(2049) }, false],
  ]) {
    const before = requests.length
    const r = await call(name, args)
    assert.equal(!(r.thrown || r.isError), ok, `${name} ${args.query?.length ?? args.url.length}`)
    assert.equal(requests.length, before + (ok ? 1 : 0))
  }
})

test("tools refuse a wait outside 10 to 600 seconds", async () => {
  const before = requests.length
  for (const w of [9, 601]) {
    const r = await call("steam_history", { query: "gaben", max_wait_seconds: w })
    assert.ok(r.thrown || r.isError)
  }
  assert.equal(requests.length, before)
})

test("a search stopped at the time limit says its sources were cancelled", async () => {
  const r = await call("search", { type: "username", identifier: "hang", max_wait_seconds: 10 })
  assert.equal(r.json.complete, false)
  assert.match(r.json.note, /sources that hadn't answered were cancelled/)
})

test("a tool whose connection drops keeps its results and says so", async () => {
  const r = await call("google_account_lookup", { query_type: "email", query: "tool-drop" })
  assert.deepEqual(r.json.results, [{ a: 1 }])
  assert.match(r.json.note, /The connection dropped before the tool finished, with 2 result\(s\) expected\. The credit may already have been used\./)
})

test("a tool reply that ends without its last line reads as a refunded failure", async () => {
  const r = await call("google_account_lookup", { query_type: "email", query: "no-done" })
  assert.deepEqual(r.json.results, [{ a: 1 }])
  assert.match(r.json.note, /The tool failed before it finished, with 2 result\(s\) expected\. A failed tool search is refunded\./)
})

test("errors and notes from the API are capped too", async () => {
  for (const [name, args] of [
    ["search", { type: "username", identifier: "big-400" }],
    ["steam_history", { query: "big-done" }],
    ["steam_history", { query: "big-note" }],
  ]) {
    const r = await call(name, args)
    const bytes = Buffer.byteLength(r.content[0].text)
    assert.ok(bytes <= 48000, `${name} ${JSON.stringify(args)}: ${bytes} bytes`)
    assert.match(r.content[0].text, /\[cut \d+ characters\]/)
  }
})

test("closing stdin during a call stops the call and ends the process", async () => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, OSINTSX_API_KEY: KEY, OSINTSX_API_URL: base }, stdio: ["pipe", "pipe", "pipe"] })
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n")
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { type: "username", identifier: "hang", max_wait_seconds: 600 } } })
  await new Promise((r) => setTimeout(r, 800))
  const closesBefore = closedEarly.filter((m) => m === "hang").length
  const exited = new Promise((r) => child.on("exit", (code) => r(code)))
  child.stdin.end()
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 3000))])
  if (code === "still running") child.kill()
  assert.notEqual(code, "still running", "process exits")
  assert.ok(await until(() => closedEarly.filter((m) => m === "hang").length > closesBefore), "the API saw the call stop")
})

test("a character split across chunks decodes correctly", async () => {
  const r = await call("search", { type: "username", identifier: "split-utf8" })
  assert.equal(r.json.hits[0].name, "Zoë 王 🎉")
})

test("an empty 200 reply isn't called complete", async () => {
  const r = await call("search", { type: "username", identifier: "empty-200" })
  assert.equal(r.json.complete, false)
  assert.match(r.json.note, /ended before every source answered/)
})

test("a cancel from the client closes the request to the API, for search and tools", async () => {
  for (const [name, args, mode] of [
    ["search", { type: "username", identifier: "hang-cancel" }, "hang-cancel"],
    ["steam_history", { query: "hang-cancel-tool" }, "hang-cancel-tool"],
  ]) {
    assert.ok(!closedEarly.includes(mode), "nothing closed this request before")
    const ac = new AbortController()
    const pending = call(name, args, { signal: ac.signal })
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(!closedEarly.includes(mode), "still open before the cancel")
    ac.abort()
    await pending
    assert.ok(await until(() => closedEarly.includes(mode)), `the API saw ${name} close`)
  }
})

test("max_wait_seconds tells the truth about what happens at the limit", async () => {
  const { tools } = await client.listTools()
  for (const t of tools) {
    const d = t.inputSchema.properties.max_wait_seconds.description
    if (t.name === "search") assert.match(d, /cancelled/)
    else assert.match(d, /keeps running on OSINT\.SX/, t.name)
  }
})

test("share-trace results keep their raw fields when asked", async () => {
  const r = await call("tiktok_share_trace", { url: "with-full", include_raw: true })
  assert.deepEqual(r.json.results[0].full, { follower_count: 5 })
  const slim = await call("tiktok_share_trace", { url: "with-full" })
  assert.deepEqual(slim.json.results[0], { id: "1" })
})

test("calls at once each get their own answer", async () => {
  const tags = ["par-a", "par-b", "par-c", "par-d"]
  const rs = await Promise.all(tags.map((t) => call("search", { type: "username", identifier: t })))
  rs.forEach((r, i) => assert.equal(r.json.hits[0].tag, tags[i]))
})

test("stdout carries only JSON-RPC, no progress without a token, and stdin closing ends the process", async () => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, OSINTSX_API_KEY: KEY, OSINTSX_API_URL: base }, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n")
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { type: "email", identifier: "status-402" } } })
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search", arguments: { type: "email", identifier: "a@example.com" } } })
  await new Promise((r) => setTimeout(r, 1500))
  const exited = new Promise((r) => child.on("exit", (code) => r(code)))
  child.stdin.end()
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 3000))])
  if (code === "still running") child.kill()
  const lines = out.split("\n").filter(Boolean)
  assert.ok(lines.length >= 4, `got ${lines.length} lines`)
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, "2.0", l)
  assert.ok(!lines.some((l) => JSON.parse(l).method === "notifications/progress"), "no progress without a progressToken")
  assert.ok(lines.some((l) => JSON.parse(l).id === 4), "the search answered")
  assert.notEqual(code, "still running", "process exits when stdin closes")
})

test("a missing key is refused before any request", async () => {
  const c = await connect({ OSINTSX_API_KEY: "", OSINTSX_API_URL: base })
  const before = requests.length
  const r = await call("search", { type: "email", identifier: "a@example.com" }, undefined, c)
  await c.close()
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /isn't set/)
  assert.equal(requests.length, before)
})

test("the code runs no commands, writes no files, and reads only its package.json", () => {
  for (const f of ["index.js", "api.js", "size.js"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8")
    assert.doesNotMatch(src, /child_process|\bfs\.|write(File|Sync)|appendFile|createWriteStream|mkdir|unlink|rmSync|exec\(|spawn\(|eval\(|new Function/, f)
    for (const m of src.matchAll(/from "node:fs"/g)) assert.match(src, /import \{ readFileSync \} from "node:fs"/, f)
    const reads = src.split("readFileSync(").length - 1
    const allowed = src.split('readFileSync(new URL("./package.json", import.meta.url), "utf8")').length - 1
    assert.equal(reads, allowed, `${f} reads only package.json`)
    assert.doesNotMatch(src, /console\.log|process\.stdout\.write/, `${f} must not write to stdout`)
  }
})

test("the key never appeared in any output in this file", () => {
  assert.ok(outputs.length > 30)
  for (const o of outputs) assert.ok(!o.includes(KEY), o.slice(0, 200))
})

test("teardown", teardown)

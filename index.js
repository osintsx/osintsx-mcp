#!/usr/bin/env node
// MCP server for the OSINT.SX API (https://osint.sx/api).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { API_URL, ApiError, clip, streamPost } from "./api.js"
import { fit } from "./size.js"
import { readFileSync } from "node:fs"

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version
const API_KEY = (process.env.OSINTSX_API_KEY || "").trim()
const KEY_FORMAT = /^[a-f0-9]{48}$/i

// Most MCP clients time out after 60s.
const DEFAULT_WAIT_S = 50
const MAX_WAIT_S = 600

const server = new McpServer({ name: "osintsx", version: VERSION })

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] })
const failure = (message) => ({ ...text(message), isError: true })

const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
// "cash_appemail" -> "Cash App"
const MODULE_SUFFIX = /(emailregister|phoneregister|email|phone|username|name)$/i
const sourceName = (className) => {
  const raw = String(className).replace(/[_-]/g, " ").replace(MODULE_SUFFIX, "").trim() || String(className)
  return raw.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
}
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => !isEmpty(v)))
const shown = (show) => (isPlainObject(show) ? compact(show) : { value: show })
const say = (v) => clip(typeof v === "string" ? v : JSON.stringify(v))

const URL_PROBLEM = (() => {
  try {
    const u = new URL(API_URL)
    return u.username || u.password ? "OSINTSX_API_URL can't contain a username or password. Remove them; the API key is all it needs." : null
  } catch {
    return "OSINTSX_API_URL isn't a valid URL."
  }
})()

// Stop running calls and exit when the client disconnects.
const shutdown = new AbortController()
const stop = () => {
  if (shutdown.signal.aborted) return
  shutdown.abort()
  setTimeout(() => process.exit(0), 300).unref()
}
process.stdin.on("end", stop)
process.stdin.on("close", stop)

// Progress must increase, so repeats are skipped. 100% is never sent, and
// settle() delays the result 50ms so a late notification can't follow it.
function progressReporter(extra) {
  const token = extra?._meta?.progressToken
  let sent = -1
  let at = 0
  const report = (progress, message) => {
    if (token === undefined) return
    const now = Date.now()
    if (progress >= 1 || progress <= sent || now - at < 1000) return
    sent = progress
    at = now
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total: 1, message } }).catch(() => {})
  }
  report.settle = () => new Promise((r) => setTimeout(r, Math.max(0, at + 50 - Date.now())))
  return report
}

const skippedNote = (n) => (n ? `${n} line(s) from the API couldn't be read and are missing here.` : undefined)
const notes = (...list) => list.filter(Boolean).join(" ") || undefined

async function run(path, body, { seconds, extra, onLine }) {
  const limit = AbortSignal.timeout(seconds * 1000)
  const signal = AbortSignal.any([limit, shutdown.signal, ...(extra?.signal ? [extra.signal] : [])])
  try {
    const { skipped } = await streamPost(path, body, { apiKey: API_KEY, signal, onLine })
    return { timedOut: limit.aborted, dropped: false, skipped }
  } catch (e) {
    if (e instanceof ApiError && e.midStream) return { timedOut: false, dropped: true, skipped: 0 }
    throw e
  }
}

function guard(handler) {
  return async (args, extra) => {
    if (!API_KEY) return failure("OSINTSX_API_KEY isn't set. Make a key at https://osint.sx/keys and add it to this server's environment.")
    if (!KEY_FORMAT.test(API_KEY)) return failure("OSINTSX_API_KEY isn't a valid key: a key is 48 characters, 0 to 9 and a to f. Copy it again from https://osint.sx/keys.")
    if (URL_PROBLEM) return failure(URL_PROBLEM)
    try {
      return await handler(args, extra)
    } catch (e) {
      if (e instanceof ApiError) return failure(e.message)
      throw e
    }
  }
}

const waitArg = (after) => z.number().int().min(10).max(MAX_WAIT_S).optional()
  .describe(`Seconds to wait before returning what has arrived so far (default ${DEFAULT_WAIT_S}). ${after}`)
const searchWait = waitArg("Sources that haven't answered by then are cancelled.")
const toolWait = waitArg("The tool keeps running on OSINT.SX after that, so its credit may still be used.")

server.registerTool(
  "search",
  {
    title: "Search every source",
    description:
      "Check one email address, phone number, username or full name against every OSINT.SX source at once " +
      "and return each site where it's registered, with the details that site shows (names, usernames, photos, " +
      "join dates). Costs 1 credit (a username search uses one of the day's free username searches first, if the " +
      "account has any); if most sources fail and nothing is found, the credit is given back. " +
      "Phone numbers must be in +E.164 format, like +14155550123.",
    inputSchema: {
      type: z.enum(["email", "phone", "username", "name"]).describe("What kind of identifier this is."),
      identifier: z.string().min(1).max(256).describe("The email, phone number, username or full name to search for."),
      include_alerting_sources: z.boolean().optional()
        .describe("Also run sources that may notify the person (for example a password-reset style check). Off by default."),
      max_wait_seconds: searchWait,
    },
    annotations: { ...ANNOTATIONS, title: "Search every source" },
  },
  guard(async ({ type, identifier, include_alerting_sources, max_wait_seconds }, extra) => {
    const report = progressReporter(extra)
    const hits = []
    let total = null
    let answered = 0
    const { timedOut, dropped, skipped } = await run("/search", { moduleType: type, identifier, alertMode: include_alerting_sources === true }, {
      seconds: max_wait_seconds ?? DEFAULT_WAIT_S,
      extra,
      onLine: (line) => {
        if (typeof line.totalModules === "number") total = line.totalModules
        if (typeof line.progress === "number") {
          answered = line.progress
          report(line.progress, `${Math.round(line.progress * 100)}% of sources answered, ${hits.length} found`)
        }
        if (line.className && line.result?.show != null) hits.push({ ...shown(line.result.show), source: sourceName(line.className) })
      },
    })
    await report.settle()
    const complete = !timedOut && !dropped && answered >= 1
    const note = notes(
      timedOut ? "Stopped at the time limit, and the sources that hadn't answered were cancelled. If your client allows longer calls, pass a higher max_wait_seconds."
        : dropped ? "The connection dropped before the search finished; these are the results that arrived."
        : complete ? undefined : "The search ended before every source answered.",
      skippedNote(skipped),
    )
    return text(fit({
      searched: { type, identifier },
      sources: total,
      sources_answered: total == null ? null : Math.round(answered * total),
      complete,
      ...(note ? { note } : {}),
      found: hits.length,
      hits,
    }, "hits"))
  }),
)

const INTERNAL_FIELDS = new Set(["pass"])
const clean = (data) => (data && typeof data === "object" && !Array.isArray(data)
  ? Object.fromEntries(Object.entries(data).filter(([k]) => !INTERNAL_FIELDS.has(k)))
  : data)
// Results with a `full` field get trimmed to `show` unless include_raw is set.
const slim = (data, raw) => (!raw && isPlainObject(data) && data.show != null ? shown(data.show) : clean(data))

function tool(name, { title, description, path, inputSchema, body, check, notFound, rawOption = false }) {
  server.registerTool(
    name,
    {
      title,
      description: `${description} Costs 1 credit (or one of a pack's free daily tool searches); finding nothing or failing costs nothing.`,
      inputSchema: {
        ...inputSchema,
        max_wait_seconds: toolWait,
        ...(rawOption ? {
          include_raw: z.boolean().optional()
            .describe("Return everything each source sent instead of the main fields. Much longer; off by default."),
        } : {}),
      },
      annotations: { ...ANNOTATIONS, title },
    },
    guard(async (args, extra) => {
      const problem = check?.(args)
      if (problem) return failure(problem)
      const results = []
      let expected = null
      let usage
      let error
      let done = false
      let outcome
      try {
        outcome = await run(path, body(args), {
          seconds: args.max_wait_seconds ?? DEFAULT_WAIT_S,
          extra,
          onLine: (line) => {
            if (line.type === "meta" && typeof line.total === "number") expected = line.total
            if (line.type === "result") results.push(slim(line.data, args.include_raw === true))
            if (line.type === "done") {
              done = true
              if (line.error) error = say(line.error)
            }
            if (line.usage) usage = line.usage
          },
        })
      } catch (e) {
        // Share traces return 404 (with usage) when there's no sharer.
        if (notFound && e instanceof ApiError && e.status === 404 && e.reason && e.body?.usage !== undefined) {
          return text(`${notFound} ${e.reason.replace(/[.\s]+$/, "")}. No credit was charged.`)
        }
        throw e
      }
      if (done && error && results.length === 0) return failure(`${error} (no credit was charged)`)
      // Tools keep running after a disconnect, so the credit may be spent.
      const expecting = expected ? `, with ${expected} result(s) expected` : ""
      const note = notes(
        done ? (error ? `The tool also reported: ${error}` : undefined)
          : outcome.timedOut || outcome.dropped
            ? `${outcome.timedOut ? "Stopped at the time limit" : "The connection dropped"} before the tool finished${expecting}. The credit may already have been used.`
            : `The tool failed before it finished${expecting}. A failed tool search is refunded.`,
        skippedNote(outcome.skipped),
      )
      return text(fit({
        found: results.length,
        ...(note ? { note } : {}),
        results,
        ...(usage ? { usage } : {}),
      }, "results"))
    }),
  )
}

const query = (what, max = 256) => z.string().min(1).max(max).describe(what)

tool("google_account_lookup", {
  title: "Google account lookup",
  description: "Find Google accounts and their Gaia IDs by email address, full name or email domain, or look one up by Gaia ID. A name search matches the whole name; use * as a wildcard for a partial name.",
  path: "/google/search",
  inputSchema: {
    query_type: z.enum(["email", "name", "domain", "gaiaId"]),
    query: query("The email, name, domain or Gaia ID."),
  },
  body: (a) => ({ queryType: a.query_type, query: a.query }),
  rawOption: true,
})

tool("microsoft_account_lookup", {
  title: "Microsoft account lookup",
  description: "Find Microsoft accounts by email address, full name or email domain, or look one up by CID. A name search matches the whole name; use * as a wildcard for a partial name.",
  path: "/microsoft/search",
  inputSchema: {
    query_type: z.enum(["email", "name", "domain", "cid"]),
    query: query("The email, name, domain or CID."),
  },
  body: (a) => ({ queryType: a.query_type, query: a.query }),
  rawOption: true,
})

tool("epic_games_lookup", {
  title: "Epic Games account lookup",
  description: "Find Epic Games accounts by display name or account ID, or by the username on a linked platform (Xbox, PlayStation, Steam and others).",
  path: "/epic/search",
  inputSchema: {
    query_type: z.enum(["username", "accountId", "platform"]),
    query: query("The display name, account ID, or the username on the linked platform.", 128),
    platform: z.enum(["xbl", "psn", "steam", "nintendo", "discord", "twitch", "github", "google", "apple", "facebook"]).optional()
      .describe("Required when query_type is platform: which linked platform the username is from."),
  },
  body: (a) => ({ queryType: a.query_type, query: a.query, ...(a.platform ? { platform: a.platform } : {}) }),
  rawOption: true,
  check: (a) => (a.query_type === "platform" && !a.platform ? "Set platform when query_type is platform: which linked platform the username is from." : null),
})

tool("twitter_history", {
  title: "X (Twitter) profile history",
  description: "Look up an X profile and its archived history: each earlier username, display name, bio, location and profile picture, including accounts X no longer shows.",
  path: "/twitter/search",
  inputSchema: {
    query_type: z.enum(["username", "user_id", "url"]),
    query: query("The username (without @), numeric user ID or profile URL.", 500),
  },
  body: (a) => ({ queryType: a.query_type, query: a.query }),
})

tool("steam_history", {
  title: "Steam profile history",
  description: "Look up a Steam profile and its archived history: earlier names, custom URLs and avatars, and other accounts that held the same custom URL.",
  path: "/steam/lookup",
  inputSchema: { query: query("A custom URL, SteamID64 (the 17-digit account number) or profile URL.", 500) },
  body: (a) => ({ query: a.query }),
})

tool("instagram_share_trace", {
  title: "Instagram share link trace",
  description: "Find the account that shared an Instagram link, from a link copied with the Share button in the app. A link from a browser's address bar can't be traced.",
  path: "/instagram/search",
  inputSchema: { url: query("The share link, as copied from the Instagram app.", 2048) },
  body: (a) => ({ url: a.url }),
  notFound: "The trace didn't find a sharer:",
  rawOption: true,
})

tool("tiktok_share_trace", {
  title: "TikTok share link trace",
  description: "Find the account that shared a TikTok link, from a short share link copied in the app. It works unless the sharer turned off account suggestions, and share links can expire.",
  path: "/tiktok/search",
  inputSchema: { url: query("The short share link, as copied from the TikTok app.", 2048) },
  body: (a) => ({ url: a.url }),
  notFound: "The trace didn't find a sharer:",
  rawOption: true,
})

await server.connect(new StdioServerTransport())

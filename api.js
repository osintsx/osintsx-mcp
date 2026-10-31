// Client for the OSINT.SX API: JSON request, NDJSON response.

export const API_URL = (process.env.OSINTSX_API_URL || "https://api.osint.sx").replace(/\/+$/, "")

const API_ORIGIN = (() => { try { return new URL(API_URL).origin } catch { return "the OSINT.SX API" } })()

const STATUS_HINTS = {
  401: "Check the OSINTSX_API_KEY setting. Keys are made at https://osint.sx/keys.",
  402: "No credits left. Buy more at https://osint.sx/pay.",
  403: "The OSINT.SX account is suspended.",
  429: "Rate limited. Wait a little before the next search.",
  503: "OSINT.SX is busy or the tool is paused. Try again in a few seconds.",
}

export class ApiError extends Error {
  constructor(status, message, { reason = null, body = null, midStream = false } = {}) {
    super(message)
    this.status = status
    this.reason = reason
    this.body = body
    this.midStream = midStream
  }
}

export const clip = (text, max = 1000) => (text.length > max ? `${text.slice(0, max)} [cut ${text.length - max} characters]` : text)

export async function streamPost(path, body, { apiKey, signal, onLine }) {
  let resp
  try {
    resp = await fetch(API_URL + path, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", "user-agent": "osintsx-mcp" },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) return { skipped: 0 }
    // Don't use e.message, it can contain the API key.
    const code = e?.cause?.code ? ` (${e.cause.code})` : ""
    throw new ApiError(0, `Couldn't reach ${API_ORIGIN}${code}.`)
  }
  if (!resp.ok) {
    let reason = null
    let errorBody = null
    try {
      errorBody = await resp.json()
      const err = errorBody?.error
      if (err) reason = clip(typeof err === "string" ? err : JSON.stringify(err))
    } catch {}
    const text = String(reason || resp.statusText || "Request failed").replace(/[.\s]+$/, "")
    // No account hint for upstream errors or messages that already link somewhere.
    const hint = /osint\.sx\/|upstream/i.test(text) ? null : STATUS_HINTS[resp.status]
    throw new ApiError(resp.status, `${resp.status}: ${clip(text)}.${hint ? ` ${hint}` : ""}`, { reason, body: errorBody })
  }

  const decoder = new TextDecoder()
  let buffer = ""
  let skipped = 0
  const flush = (text) => {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      let data
      try { data = JSON.parse(line) } catch { skipped++; continue }
      if (!data || typeof data !== "object") { skipped++; continue }
      try { onLine(data) } catch { skipped++ }
    }
  }
  try {
    for await (const chunk of resp.body) {
      const piece = decoder.decode(chunk, { stream: true })
      buffer += piece
      if (!piece.includes("\n")) continue
      const end = buffer.lastIndexOf("\n")
      flush(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
    }
    flush(buffer + decoder.decode())
  } catch {
    if (signal?.aborted) return { skipped }
    throw new ApiError(0, "The connection to OSINT.SX dropped before the reply finished.", { midStream: true })
  }
  return { skipped }
}

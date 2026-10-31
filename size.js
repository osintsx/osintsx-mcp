// Keep replies under ~48KB. Counted in bytes so CJK text stays under the
// ~25k token limit of most clients.

export const MAX_BYTES = 48000

export const cost = (v) => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8")

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export function trimValue(v, budget) {
  if (cost(v) <= budget) return v

  if (typeof v === "string") {
    let keep = Math.max(0, Math.floor(v.length * (budget / cost(v))) - 40)
    for (;;) {
      const out = `${v.slice(0, keep)} [cut ${v.length - keep} characters]`
      if (cost(out) <= budget || keep === 0) return out
      keep = Math.floor(keep * 0.8)
    }
  }

  if (Array.isArray(v)) {
    const out = []
    let used = 2 // []
    for (let i = 0; i < v.length; i++) {
      const marker = `[${v.length - i} more not shown]`
      const room = budget - used - cost(marker) - 2
      const item = cost(v[i]) <= room ? v[i] : i === 0 ? trimValue(v[i], room) : undefined
      if (item === undefined || cost(item) > room) {
        out.push(marker)
        return out
      }
      out.push(item)
      used += cost(item) + 1
    }
    return out
  }

  if (isPlainObject(v)) {
    const out = { ...v }
    let excess = cost(out) - budget
    const largest = Object.keys(out).sort((a, b) => cost(out[b]) - cost(out[a]))
    for (const k of largest) {
      if (excess <= 0) break
      const before = cost(out[k])
      out[k] = trimValue(out[k], Math.max(0, before - excess))
      excess -= before - cost(out[k])
    }
    return out
  }

  return v
}

export function fit(obj, key) {
  const list = obj[key]
  if (cost(obj) <= MAX_BYTES) return obj
  const room = MAX_BYTES - cost({ ...obj, [key]: [], omitted: list.length, omitted_note: NOTE(list.length) })
  const cap = list.length > 1 ? Math.floor(room / 2) : room
  const kept = []
  let used = 0
  for (const raw of list) {
    const item = trimValue(raw, cap)
    const c = cost(item) + 1
    if (used + c > room) continue
    kept.push(item)
    used += c
  }
  const omitted = list.length - kept.length
  return { ...obj, [key]: kept, ...(omitted ? { omitted, omitted_note: NOTE(omitted) } : {}) }
}

const NOTE = (n) => `${n} more not shown, to keep the reply small enough for the client. Some long fields may also be shortened, marked "[cut ...]" or "[... more not shown]".`

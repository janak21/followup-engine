// Client-side in-memory cache for API endpoints to support instant back-navigation (stale-while-revalidate pattern)
let cache = {}
let channel = null

if (typeof window !== "undefined") {
  channel = new BroadcastChannel("api-cache-channel")
  channel.onmessage = (event) => {
    const { type, key, data } = event.data || {}
    if (type === "set") {
      cache[key] = data
      window.dispatchEvent(new CustomEvent("api-cache-updated", { detail: { key, data } }))
    } else if (type === "clear") {
      cache = {}
      window.dispatchEvent(new CustomEvent("api-cache-cleared"))
    } else if (type === "invalidate") {
      delete cache[key]
      window.dispatchEvent(new CustomEvent("api-cache-invalidated", { detail: { key } }))
    }
  }
}

export function getCachedData(key) {
  if (typeof window === "undefined") return null
  return cache[key] || null
}

export function setCachedData(key, data, broadcast = true) {
  if (typeof window === "undefined") return
  cache[key] = data
  if (broadcast && channel) {
    channel.postMessage({ type: "set", key, data })
  }
}

export function invalidateCachedData(key, broadcast = true) {
  if (typeof window === "undefined") return
  delete cache[key]
  if (broadcast && channel) {
    channel.postMessage({ type: "invalidate", key })
  }
}

export function clearCache(broadcast = true) {
  cache = {}
  if (typeof window !== "undefined" && broadcast && channel) {
    channel.postMessage({ type: "clear" })
  }
}


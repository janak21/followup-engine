import { NextResponse } from "next/server"
import { requireOperator } from "@/utils/role";
import { lookup } from "node:dns/promises";
import net from "node:net";

function isBlockedIpv4(ip) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function hostLooksInternal(host) {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "localhost.localdomain" ||
    normalized === "metadata.google.internal" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials in URLs are not allowed. Use headers instead.");
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) throw new Error("URL host is required.");
  if (host.includes(":")) throw new Error("IPv6 literal URLs are not allowed.");
  if (hostLooksInternal(host)) throw new Error("Internal hostnames are blocked.");

  const literalKind = net.isIP(host);
  if (literalKind === 6) throw new Error("IPv6 literal URLs are not allowed.");
  if (literalKind === 4) {
    if (isBlockedIpv4(host)) throw new Error("Private or internal IP addresses are blocked.");
    return;
  }

  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error("Could not resolve URL host.");
  for (const record of records) {
    if (record.family !== 4) throw new Error("Only public IPv4 DNS results are allowed.");
    if (isBlockedIpv4(record.address)) throw new Error("URL resolves to a private or internal IP address.");
  }
}

export async function POST(req) {
  const __guard = await requireOperator(req); if (__guard) return __guard;
  try {
    const { method, url, headers, body, timeout_ms } = await req.json()
    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 })
    }
    await assertPublicHttpUrl(url)

    // Mirror the runtime executor's clamp (1s..30s, default 10s).
    const timeoutMs = Math.max(1000, Math.min(30000, Number(timeout_ms) || 10000))

    const options = {
      method: method || "POST",
      headers: headers || {},
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    }

    if (["POST", "PUT", "PATCH", "DELETE"].includes(options.method) && body) {
      options.body = typeof body === "string" ? body : JSON.stringify(body)
    }

    const startTime = Date.now()
    const res = await fetch(url, options)
    const duration = Date.now() - startTime

    const responseHeaders = {}
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    let responseBody
    const contentType = res.headers.get("content-type") || ""
    if (contentType.includes("application/json")) {
      try {
        responseBody = await res.json()
      } catch {
        responseBody = await res.text()
      }
    } else {
      responseBody = await res.text()
    }

    return NextResponse.json({
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      body: responseBody,
      durationMs: duration
    })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

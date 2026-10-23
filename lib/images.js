"use strict";
// Downloads chat images for vision models. Only fetches from known image hosts unless told otherwise.

const DEFAULT_HOSTS = [
  /(^|\.)steamusercontent\.com$/i,
  /^steamuserimages-a\.akamaihd\.net$/i,
  /(^|\.)steamstatic\.com$/i,
  /(^|\.)giphy\.com$/i,
  /(^|\.)tenor\.com$/i,
  /^i\.imgur\.com$/i,
  /^(cdn|media)\.discordapp\.(com|net)$/i
];

function hostAllowed(url, allowAny) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (DEFAULT_HOSTS.some(re => re.test(u.hostname))) return true;
  if (!allowAny) return false;
  // "any host" still refuses localhost / IP literals so a chat message cannot probe the local network
  return !/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) && !/^[\d.]+$|:/.test(u.hostname);
}

async function fetchImage(url, { maxBytes = 8 * 1024 * 1024, timeoutMs = 10000, allowAnyHost = false } = {}) {
  if (!hostAllowed(url, allowAnyHost)) throw new Error("image host not allowed: " + new URL(url).hostname);
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!res.ok) throw new Error("image HTTP " + res.status);
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error("not an image: " + (type || "unknown type"));
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("image too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("image too large");
  return { url, mime: type, base64: buf.toString("base64"), bytes: buf.length };
}

// Fetches up to `max` images; failures are reported, never thrown.
async function fetchImages(urls, { max = 3, ...opts } = {}, log = () => {}) {
  const out = [];
  for (const url of urls.slice(0, max)) {
    try {
      out.push(await fetchImage(url, opts));
    } catch (err) {
      log("[vision] skipped image:", err.message);
    }
  }
  return out;
}

module.exports = { fetchImage, fetchImages, hostAllowed };

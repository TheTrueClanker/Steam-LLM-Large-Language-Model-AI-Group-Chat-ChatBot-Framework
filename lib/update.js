"use strict";
// Looks for a newer GitHub release of the project and, for the desktop app, finds the installer for this OS.
// It only reads release information. Downloading and installing happens in the app, after the user clicks.

// Releases are read from the original project by default. Forks can point it elsewhere with
// "Update source = owner/repo" in config.txt.
const DEFAULT_REPO = "TheTrueClanker/Steam-LLM-Large-Language-Model-AI-Group-Chat-ChatBot-Framework";

const parse = v => String(v).replace(/^v/i, "").split("-")[0].split(".").map(n => parseInt(n, 10) || 0);

function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

const validRepo = r => /^[\w.-]+\/[\w.-]+$/.test(String(r));

// Picks the installer asset for a platform ("win32", "linux", "darwin") from a GitHub release's asset list.
function pickAsset(assets, platform) {
  const re = platform === "win32" ? /\.exe$/i : platform === "linux" ? /\.AppImage$/i : null;
  if (!re) return null;
  const hit = (assets || []).find(a => re.test(a.name || "") && a.browser_download_url);
  return hit ? { name: hit.name, url: hit.browser_download_url, size: hit.size || 0, sha256: /^sha256:([0-9a-f]{64})$/i.exec(hit.digest || "")?.[1] || "" } : null;
}

async function checkForUpdate(currentVersion, { repo = DEFAULT_REPO, platform = process.platform, fetchFn = fetch } = {}) {
  if (!validRepo(repo)) throw new Error("Update source must look like owner/repo");
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "steam-llm-chatbot" },
    signal: AbortSignal.timeout(8000)
  });
  if (res.status === 404) return { available: false, latest: currentVersion, repo }; // no releases published yet
  if (!res.ok) throw new Error("GitHub HTTP " + res.status);
  const rel = await res.json();
  const latest = String(rel.tag_name || "").replace(/^v/i, "");
  const available = !!latest && isNewer(latest, currentVersion);
  return { available, latest, repo, url: rel.html_url, notes: String(rel.body || "").slice(0, 600), asset: available ? pickAsset(rel.assets, platform) : null };
}

module.exports = { checkForUpdate, isNewer, pickAsset, DEFAULT_REPO };

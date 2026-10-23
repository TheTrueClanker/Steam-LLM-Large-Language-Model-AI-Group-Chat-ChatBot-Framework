"use strict";
// Turns Steam chat BBCode into plain text for the model, and pulls image URLs out of it.
// Wire formats follow the node-steam-user docs; tags we have not seen are simply stripped.

const ESC = "\u0001"; // placeholder for a literal "\[" the sender typed
const IMG = "\u0002"; // placeholder for an image tag

function bbcodeToPlain(raw) {
  let s = String(raw ?? "").replace(/\\\[/g, ESC);

  s = s.replace(/\[emoticon\]([\w-]+)\[\/emoticon\]/gi, ":$1:");
  s = s.replace(/\[(?:sticker|roomeffect)\b[^\]]*?type="([^"]+)"[^\]]*\](?:\s*\[\/(?:sticker|roomeffect)\])?/gi, "(sticker: $1)");
  s = s.replace(/\[mention=\d+\]([\s\S]*?)\[\/mention\]/gi, "$1");
  s = s.replace(/\[random\b[^\]]*?result="(\d+)"[^\]]*\](?:\s*\[\/random\])?/gi, "(rolled $1)");
  s = s.replace(/\[flip\b[^\]]*?result="(\w+)"[^\]]*\](?:\s*\[\/flip\])?/gi, "(flipped $1)");
  s = s.replace(/\[img\b[^\]]*\](?:[\s\S]*?\[\/img\])?/gi, IMG); // restored after the generic tag strip below
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_m, url, text) => (text && text !== url ? `${text} (${url})` : url));
  s = s.replace(/\[\/?[a-z][a-z0-9]*(?:[ =][^\]]*)?\]/gi, ""); // any other tag: drop the tag, keep inner text

  return s.replace(new RegExp(ESC, "g"), "[").replace(new RegExp(IMG, "g"), "[image]").replace(/[ \t]+/g, " ").trim();
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?[^\s\]"]*)?$/i;
const STEAM_UGC = /(^|\.)steamusercontent\.com$|^steamuserimages-a\.akamaihd\.net$/i;

// Returns unique candidate image URLs (https only), most specific first.
function extractImageUrls(raw) {
  const s = String(raw ?? "").replace(/\\\[/g, ESC);
  const urls = [];
  const add = u => {
    u = String(u || "").trim().replace(/[)\].,;]+$/, "");
    if (/^https:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
  };

  for (const m of s.matchAll(/\[img\b([^\]]*)\]([^\[]*)(?:\[\/img\])?/gi)) {
    const attrs = m[1];
    // Giphy-style tags carry a small still/gif in thumbnail_src; prefer it over the page link in src.
    add(attrs.match(/thumbnail_src="([^"]+)"/i)?.[1]);
    add(attrs.match(/\bsrc="([^"]+)"/i)?.[1]);
    for (const u of attrs.match(/https:\/\/[^\s"'\]\[]+/g) || []) add(u);
    add(m[2]); // [img]https://...[/img]
  }
  for (const m of s.matchAll(/\[url=([^\]]+)\]/gi)) {
    if (isImageUrl(m[1])) add(m[1]);
  }
  for (const m of s.matchAll(/https:\/\/[^\s\[\]"<>]+/gi)) {
    if (isImageUrl(m[0])) add(m[0]);
  }
  return urls;
}

function isImageUrl(u) {
  try {
    const url = new URL(u);
    return IMAGE_EXT.test(url.pathname + url.search) || (STEAM_UGC.test(url.hostname) && /\/ugc\//i.test(url.pathname));
  } catch {
    return false;
  }
}

// Did this message @mention the given account? `mentions` is steam-user's parsed object (or null).
function isMentioned(message, accountId) {
  const m = message?.mentions;
  if (m) {
    if (m.mention_all || m.mention_here) return true;
    if (accountId != null && (m.mention_steamids || []).some(id => Number(id?.accountid ?? id) === Number(accountId))) return true;
  }
  return accountId != null && new RegExp(`\\[mention=${Number(accountId)}\\]`).test(String(message?.message || ""));
}

// Group-chat invites arrive in a DM as [invite chatgroupid="123" chatgroupname="Name"][/invite].
function extractInvites(raw) {
  const out = [];
  for (const m of String(raw ?? "").matchAll(/\[invite\b([^\]]*)\]/gi)) {
    const id = m[1].match(/chatgroupid="(\d+)"/i)?.[1];
    if (id) out.push({ chatGroupId: id, groupName: m[1].match(/chatgroupname="([^"]*)"/i)?.[1] || "" });
  }
  return out;
}

module.exports = { bbcodeToPlain, extractImageUrls, isMentioned, extractInvites };

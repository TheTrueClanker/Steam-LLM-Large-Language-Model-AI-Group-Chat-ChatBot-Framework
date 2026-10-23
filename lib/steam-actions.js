"use strict";
// Steam chat "actions" the model can use by writing small inline tags in its reply, plus the Steam-side
// plumbing for them (reactions, owned emoticons). Small local models are bad at tool-calling but fine at
// writing a tag, so tags are parsed out of the reply by the bot, which decides what is actually sent.
//
//   [react:steamhappy]   react to the message being answered
//   [me:waves hello]     an action line, sent as "/me waves hello"
//   [mention:Name]       @mention a group member (plain "@Name" in DMs)
//   [spoiler:text]       hidden text, sent as its own "/spoiler text" message (Steam only turns that into a
//                        spoiler when it is a whole message; a [spoiler] tag inside other text is stripped)
//   [store:Game Name]    a link to a game's Steam store page. "/store" is client-side only (a bot sends it as literal
//                        text), so the game is looked up by name in Steam's store search and its URL is sent.
//   :emoticon:           plain text, rendered by Steam
//
// Reactions use steam-user's protected _sendUnified because steam-user has no reaction API yet;
// every call is wrapped so a protocol change degrades to "no reaction" instead of an error.

const TAG = /\[\/?(react|me|spoiler|mention|store):\s*([^\]]{1,300})\](?:\s*\[\/(?:react|me|spoiler|mention|store)\])?/gi; // tolerates "[/me:..]" and a closing tag
const OPEN = "\u0002";
const CLOSE = "\u0003";

const ALL_ON = { react: true, me: true, spoiler: true, mention: true, store: true };

function cleanEmoticonName(name) {
  const n = String(name || "").replace(/:/g, "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(n) ? n : "";
}

// Literal text from the model must never be read as BBCode by Steam.
function escapeBb(text) {
  return String(text).replace(/\[/g, "\\[");
}

// Pulls action tags out of a model reply.
// Returns { plain, actions, bbcode(roster, isGroup) }:
//   plain  - the reply with tags resolved to readable text (for memory/logs)
//   actions - [{type:"react", name} | {type:"me", text}] to perform besides the text message
//   bbcode - the text as it should be sent to Steam (escaped, with generated mentions/spoilers)
// Small models garble emoticons (":steamhappy!", ":steamocking"). With the owned list known, repair near-misses
// to the real name and delete anything that is not an emoticon this account has. emoticonsOn=false removes them all.
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function fixEmoticons(text, owned, emoticonsOn) {
  if (!owned && emoticonsOn) return text; // list unknown: leave text alone
  let kept = 0; // small models sprinkle them everywhere, so at most one survives per message
  return text.replace(/(^|[\s(])(:?)([A-Za-z][A-Za-z0-9_]{2,40})(?::|(?=[!?.,~)\s]|$))/g, (m, pre, openColon, name) => {
    const hadBothColons = m.endsWith(":") && openColon === ":";
    if (!openColon || (!hadBothColons && !/^steam/i.test(name) && !owned?.has(name))) return m; // ordinary word
    if (!emoticonsOn) return pre;
    const lower = name.toLowerCase();
    let best = null;
    for (const o of owned) if (o.toLowerCase() === lower || (lev(o.toLowerCase(), lower) <= 2 && /^steam/i.test(name))) best = best && lev(best.toLowerCase(), lower) <= lev(o.toLowerCase(), lower) ? best : o;
    if (best && kept++ === 0) return `${pre}:${best}:`;
    return pre;
  });
}

function parseActions(reply, enabled = ALL_ON, { ownedEmoticons = null, emoticons = true } = {}) {
  const actions = [];
  const raw = String(reply ?? "").split(OPEN).join("").split(CLOSE).join("");

  // models often write "[steamhappy]" instead of "[react:steamhappy]"
  const bare = ownedEmoticons ? raw.replace(/\[:?([A-Za-z0-9_]+):?\]/g, (m, n) => (ownedEmoticons.has(n) ? `[react:${n}]` : m)) : raw;

  const marked0 = bare.replace(TAG, (_m, type, arg) => {
    type = type.toLowerCase();
    arg = arg.trim();
    if (!enabled[type]) return type === "spoiler" || type === "mention" ? arg : "";
    switch (type) {
      case "react": {
        const name = cleanEmoticonName(arg);
        if (name && (!ownedEmoticons || ownedEmoticons.has(name)) && !actions.some(a => a.type === "react")) actions.push({ type, name });
        return "";
      }
      case "me":
        if (arg && actions.length < 3) actions.push({ type, text: arg });
        return "";
      case "store": {
        // Resolved to a store URL when sending (see storeLinkFor).
        const name = arg.replace(/[\[\]\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (name && !actions.some(a => a.type === "store")) actions.push({ type, text: name });
        return "";
      }
      case "spoiler":
        if (arg && !actions.some(a => a.type === "spoiler")) actions.push({ type, text: arg });
        return "";
      case "mention":
        return `${OPEN}M${arg.replace(/^@/, "")}${CLOSE}`;
    }
    return "";
  });
  // Models also invent syntax: links with made-up schemes ("linkstore:app://123") and slash commands in the
  // middle of a sentence (they only work at the start of a message). Drop both.
  const cleaned = marked0
    .replace(/\S*:\/\/\S+/g, m => (/^https?$/i.test(m.match(/([A-Za-z][A-Za-z0-9+.-]*):\/\//)?.[1] || "") ? m : ""))
    .replace(/(?<=\S\s)\/(?:me|code|pre|giphy|quote|random|flip|store|spoiler|sticker|roomeffect)\b:?/gi, "");
  const marked = fixEmoticons(cleaned, ownedEmoticons, emoticons);

  const tidy = s => s.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
  const placeholder = new RegExp(`${OPEN}([M])([^${CLOSE}]*)${CLOSE}`, "g");

  const plain = tidy(marked.replace(placeholder, (_m, kind, arg) => (kind === "M" ? `@${arg}` : arg)));

  function bbcode(roster, isGroup) {
    const escaped = escapeBb(tidy(marked)).replace(new RegExp(`${OPEN}([M])([^${CLOSE}]*)${CLOSE}`, "g"), (_m, kind, arg) => {
      const person = isGroup && roster ? findPerson(roster, arg) : null;
      return person ? `[mention=${person.accountid}]@${escapeBb(person.name)}[/mention]` : `@${arg}`;
    });
    return escaped;
  }

  return { plain, actions, bbcode };
}

// Prompt block telling the model which actions exist. Empty when everything is off.
function actionsPrompt(enabled, { ownedEmoticons = [], isGroup = true } = {}) {
  // Kept short and placed before the persona-heavy parts of the prompt: long tag instructions made small
  // models drop their usual style (sign-offs, quirks).
  const tags = [];
  if (enabled.react) tags.push("[react:steamhappy] reacts to the message you are answering");
  if (enabled.me) tags.push("[me:waves] an action line");
  if (enabled.mention && isGroup) tags.push("[mention:Name] mentions someone here");
  if (enabled.spoiler) tags.push("[spoiler:text] hidden text");
  if (enabled.store) tags.push("[store:Game Name] links a game's store page");
  const out = [];
  if (tags.length) out.push("Rare optional extras you may add to a normal reply (at most one, only if it clearly fits): " + tags.join("; ") + ". Your reply still keeps your usual voice and sign-off.");
  if (ownedEmoticons.length) {
    out.push("Emoticons are optional; if one clearly fits you may write it: " + ownedEmoticons.slice(0, 30).map(n => `:${n}:`).join(" "));
  }
  return out.join("\n");
}

// Names are matched loosely: "hakai" finds "【HAKAI】" ("[AI BOT] Kisaragi" is found by "kisaragi").
const loose = n => String(n).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function findPerson(roster, wanted) {
  const w = loose(wanted);
  if (!w) return null;
  let partial = null;
  for (const [key, person] of roster) {
    const k = loose(key);
    if (k === w) return person;
    if (!partial && (k.includes(w) || w.includes(k)) && Math.min(k.length, w.length) >= 3) partial = person;
  }
  return partial;
}

// roster: Map(lowercase name -> {accountid, name}) of people recently seen in a room.
// `display` is the person's real Steam profile name, which is what a mention must show; `name` is how chat refers to them.
function rememberPerson(roster, name, accountid, limit = 60, display = "") {
  const n = String(name || "").trim();
  if (!n || !Number.isInteger(accountid)) return;
  roster.delete(n.toLowerCase());
  roster.set(n.toLowerCase(), { accountid, name: String(display || n).trim() });
  while (roster.size > limit) roster.delete(roster.keys().next().value);
}

// steam-user only registers the protobufs it uses itself. Reactions are not among them, so we encode and
// decode those messages with steam-user's own generated schema (a message with no registered protobuf is
// delivered to us as a raw Buffer, which is what the decode step below expects).
function loadSteamUserInternals() {
  const root = require("path").dirname(require.resolve("steam-user/package.json"));
  return {
    Schema: require(require("path").join(root, "protobufs/generated/_load.js")),
    Messages: require(require("path").join(root, "components/03-messages.js")),
    EMsg: require("steam-user").EMsg
  };
}

// Finds a game's store page by name via Steam's public store search. Close enough is fine ("beamng" finds BeamNG.drive).
const storeCache = new Map();
async function storeLinkFor(name, fetchFn = fetch) {
  const key = String(name).toLowerCase().trim();
  if (!key) return "";
  if (storeCache.has(key)) return storeCache.get(key);
  let url = "";
  try {
    const res = await fetchFn(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(key)}&l=english&cc=us`, { signal: AbortSignal.timeout(6000) });
    const hit = (await res.json())?.items?.[0];
    if (hit?.id) url = `https://store.steampowered.com/app/${hit.id}`;
  } catch {}
  if (url) storeCache.set(key, url);
  return url;
}

function createSteamActions(client, log = () => {}) {
  let owned = null; // Set of emoticon names, null = not loaded / unavailable
  let ownedList = [];

  // method: "Service.Method#1"; request: a Schema class name for the request, or null if steam-user knows it.
  function rpc(method, data, timeoutMs = 10000, requestSchema = null) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(method + " timed out")), timeoutMs);
      const done = (body, hdr) => {
        clearTimeout(timer);
        const eresult = hdr?.proto?.eresult;
        if (eresult !== undefined && eresult !== null && eresult !== 1) reject(new Error(`${method} failed (EResult ${eresult})`));
        else resolve(body);
      };
      try {
        if (!requestSchema) return client._sendUnified(method, data, done);
        const { Schema, Messages, EMsg } = loadSteamUserInternals();
        client._send(
          { msg: EMsg.ServiceMethodCallFromClient, proto: { target_job_name: method } },
          Messages._encodeProto(Schema[requestSchema], data),
          done
        );
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async function loadEmoticons() {
    try {
      const body = await rpc("Player.GetEmoticonList#1", {});
      const list = (body.emoticons || [])
        .filter(e => e.name && Number(e.count ?? 1) > 0)
        .sort((a, b) => Number(b.use_count || 0) - Number(a.use_count || 0))
        .map(e => cleanEmoticonName(e.name))
        .filter(Boolean);
      ownedList = Array.from(new Set(list));
      owned = ownedList.length ? new Set(ownedList) : null;
      log(`[actions] ${ownedList.length} emoticons available to this account: ${ownedList.join(", ")}`);
    } catch (err) {
      log("[actions] could not read the emoticon list:", err.message);
    }
    return ownedList;
  }

  // target: {kind:"dm", steamID} | {kind:"group", groupId, chatId}; message: {serverTimestamp:Date|number, ordinal}
  async function react(target, message, name, isAdd = true) {
    const emoticon = cleanEmoticonName(name);
    if (!emoticon) throw new Error("invalid emoticon name");
    const ts = message.serverTimestamp instanceof Date ? message.serverTimestamp.getTime() : Number(message.serverTimestamp);
    const server_timestamp = Math.floor((ts > 1e11 ? ts / 1000 : ts) || 0);
    if (!server_timestamp) throw new Error("message has no server timestamp");
    const base = { server_timestamp, ordinal: Number(message.ordinal) || 0, reaction_type: 1, is_add: !!isAdd };
    const send = reaction => {
      log("[actions] reaction request", JSON.stringify({ ...base, reaction, kind: target.kind }));
      if (target.kind === "dm") {
        const steamid = target.steamID?.getSteamID64 ? target.steamID.getSteamID64() : String(target.steamID);
        return rpc("FriendMessages.UpdateMessageReaction#1", { ...base, reaction, steamid }, 10000, "CFriendMessages_UpdateMessageReaction_Request");
      }
      return rpc("ChatRoom.UpdateMessageReaction#1", { ...base, reaction, chat_group_id: String(target.groupId), chat_id: String(target.chatId) }, 10000, "CChatRoom_UpdateMessageReaction_Request");
    };
    // Steam wants the colon form (":name:"); the bare name is kept as a fallback.
    try {
      return await send(`:${emoticon}:`);
    } catch (err) {
      log("[actions] colon form rejected (" + err.message + "), retrying bare name");
      return await send(emoticon);
    }
  }

  // Calls cb({kind, reactor, name, isAdd, ordinal, serverTimestamp, groupId?, chatId?, friend?}) for reactions
  // anyone adds to messages in our chats. Uses steam-user internals, so failure just means no events.
  function onReaction(cb) {
    const wrap = (kind, body) => {
      try {
        cb({
          kind,
          reactor: String(body.reactor ?? ""),
          name: cleanEmoticonName(body.reaction),
          isAdd: body.is_add !== false,
          ordinal: Number(body.ordinal) || 0,
          serverTimestamp: Number(body.server_timestamp) || 0,
          groupId: body.chat_group_id != null ? String(body.chat_group_id) : undefined,
          chatId: body.chat_id != null ? String(body.chat_id) : undefined,
          friend: body.steamid_friend != null ? String(body.steamid_friend) : undefined
        });
      } catch (err) {
        log("[actions] reaction handler failed:", err.message);
      }
    };
    try {
      const { Schema, Messages } = loadSteamUserInternals();
      const decode = (schema, body) => (Buffer.isBuffer(body) || typeof body?.toBuffer === "function" ? Messages._decodeProto(Schema[schema], body) : body);
      client._handlerManager.add("FriendMessagesClient.MessageReaction#1", body => wrap("dm", decode("CFriendMessages_MessageReaction_Notification", body)));
      client._handlerManager.add("ChatRoomClient.NotifyMessageReaction#1", body => wrap("group", decode("CChatRoom_MessageReaction_Notification", body)));
    } catch (err) {
      log("[actions] cannot listen for reactions:", err.message);
    }
  }

  return {
    loadEmoticons,
    react,
    onReaction,
    get owned() { return owned; },
    get ownedList() { return ownedList; }
  };
}

module.exports = { storeLinkFor, findPerson, parseActions, actionsPrompt, rememberPerson, createSteamActions, cleanEmoticonName, escapeBb, ALL_ON };

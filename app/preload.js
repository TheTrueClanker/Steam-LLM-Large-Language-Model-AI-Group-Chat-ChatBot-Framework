"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld("api", {
  listBots: invoke("bots:list"),
  createBot: invoke("bots:create"),
  renameBot: invoke("bots:rename"),
  deleteBot: invoke("bots:delete"),
  getConfig: invoke("config:get"),
  setConfig: invoke("config:set"),
  getPrompt: invoke("prompt:get"),
  setPrompt: invoke("prompt:set"),
  openData: invoke("data:open"),
  openLink: invoke("link:open"),
  getUi: invoke("ui:get"),
  setAutostart: invoke("bots:autostart"),
  checkUpdate: invoke("update:check"),
  installUpdate: invoke("update:install"),
  onUpdateProgress: subscribe("update:progress"),
  setUi: invoke("ui:set"),
  botStart: invoke("bot:start"),
  botStop: invoke("bot:stop"),
  botInput: invoke("bot:input"),
  chatSend: invoke("chat:send"),
  chatReset: invoke("chat:reset"),
  chatStop: invoke("chat:stop"),
  ollamaTags: invoke("ollama:tags"),
  ollamaPull: invoke("ollama:pull"),
  personaGenerate: invoke("persona:generate"),
  personaMerge: invoke("persona:merge"),
  onLog: subscribe("bot:log"),
  onExit: subscribe("bot:exit"),
  onChat: subscribe("chat:msg"),
  onChatLog: subscribe("chat:log"),
  onPullProgress: subscribe("ollama:progress"),
});

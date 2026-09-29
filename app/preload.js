"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld("api", {
  getConfig: invoke("config:get"),
  setConfig: invoke("config:set"),
  getPrompt: invoke("prompt:get"),
  setPrompt: invoke("prompt:set"),
  openData: invoke("data:open"),
  openLink: invoke("link:open"),
  botStart: invoke("bot:start"),
  botStop: invoke("bot:stop"),
  botInput: invoke("bot:input"),
  botRunning: invoke("bot:running"),
  ollamaTags: invoke("ollama:tags"),
  ollamaPull: invoke("ollama:pull"),
  onLog: subscribe("bot:log"),
  onExit: subscribe("bot:exit"),
  onPullProgress: subscribe("ollama:progress"),
});

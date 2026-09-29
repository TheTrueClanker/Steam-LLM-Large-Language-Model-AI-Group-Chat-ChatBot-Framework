# Desktop app and installer

An Electron GUI around the framework's `bot.js`: a first-run setup wizard, a settings editor for `config.txt`, a system prompt editor, start/stop with a live console, and an Ollama helper that detects Ollama and pulls models.

Ollama itself is not bundled. Install it from https://ollama.com/download; the app checks for it and links there if it's missing.

## Get an installer

Run the **Build installers** workflow (Actions tab), or push a `v*` tag. Download the artifacts:

- Windows: `SteamLLMChatbot-Setup-<version>.exe` (setup wizard, choose install folder)
- Linux: `SteamLLMChatbot-<version>.AppImage` (`chmod +x` it, then run it)

The installers are unsigned, so Windows SmartScreen will warn on first run.

**Linux sandbox:** on distros that restrict unprivileged user namespaces (e.g. Ubuntu 24.04) an Electron AppImage may refuse to start with a sandbox error. Run it as `./SteamLLMChatbot-<version>.AppImage --no-sandbox` (the app only ever loads its own local files).

## Run from source

```
cd app
npm install
npm start
```

Build locally with `npm run dist` (Linux builds the AppImage; the Windows installer needs a Windows machine or the workflow above).

## Where things live

The bot's config, system prompt, logs and memory are kept in your user data folder, not the install folder (the AppImage is read-only). Use **Open data folder** on the Dashboard to find it. On first launch the app copies the default `config.txt` and `system prompt.txt` there.

`bot.js` is started with the app's bundled Node runtime, and `STEAM_BOT_DATA_DIR` tells it where that data folder is. Running `start.bat` / `start.sh` still works as before.

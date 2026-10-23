# Steam LLM Group Chat Chatbot Framework

Run a characterful Steam chatbot with a local [Ollama](https://ollama.com) model. It can chat in DMs and groups, understand images, remember people, use selected Steam chat features, and run either from a desktop app or directly from a terminal.

## Highlights

- **Local models:** conversations are generated through your own Ollama server.
- **Steam DMs and groups:** separate reply modes for each group and for DMs.
- **Images and thinking models:** direct vision when supported, or an optional second model that describes images first.
- **Steam actions:** reactions, `/me`, mentions, spoilers, store cards, emoticons, and DM typing indicators.
- **Memory and friendships:** useful facts and gradual relationship changes based on full conversational context.
- **Desktop app:** setup wizard, multi-bot manager, test chat, persona writer, live console, themes, tray mode, and updates.
- **Resource controls:** one-model-at-a-time loading, context limits, keep-alive controls, timeouts, log rotation, and graceful shutdown.
- **Terminal mode:** the full framework remains usable without Electron.

> [!IMPORTANT]
> Use a separate Steam account for the bot whenever possible. The framework can read that account's DMs and group messages, and Steam credentials are stored locally in plain text in `config.txt`.

> [!NOTE]
> This project is intended for entertainment and community use. Do not use it for harassment, impersonation, spam, credential collection, or other malicious activity.

## Credits

The original framework was created by Steam user [Ultragys](https://steamcommunity.com/id/Ultragys/), who gave permission for it to be published here. Continued development has been collaborative and AI-assisted.

Arch testing, the desktop app, and later framework improvements were developed by [Hakai](https://github.com/HakaiNoNeko) with his AI assistant [Yuki](https://github.com/yukiopenclaw-bot).

## Choose How to Run It

| Method | Best for | Requirements |
| --- | --- | --- |
| **Desktop app** | Most users, multiple bots, visual setup and testing | Ollama and a Steam account |
| **Terminal** | Servers, development, lightweight deployments | Ollama, Node.js 18+, npm, and a Steam account |

Both methods run the same `bot.js` reply pipeline and use the same configuration format.

## Desktop App

### Install

Download the newest build from the [Releases page](../../releases/latest):

- **Windows:** run `SteamLLMChatbot-Setup-<version>.exe` and choose an installation folder. The installer is unsigned, so Windows SmartScreen may require **More info → Run anyway**.
- **Linux:** download `SteamLLMChatbot-<version>.AppImage`, make it executable, and run it:

  ```bash
  chmod +x SteamLLMChatbot-<version>.AppImage
  ./SteamLLMChatbot-<version>.AppImage
  ```

  If the distribution blocks Electron's sandbox, use:

  ```bash
  ./SteamLLMChatbot-<version>.AppImage --no-sandbox
  ```

Ollama is not bundled. Install it from [ollama.com/download](https://ollama.com/download); the app can detect it and pull models for you. Node.js is bundled through Electron and is not required separately for an installed desktop build.

### First Run

1. Open the app and follow the setup wizard.
2. Select or pull an Ollama model.
3. Enter the bot's Steam login, name, aliases, and personality.
4. Use **Test chat** to try the persona without connecting to Steam.
5. Press **Start bot** and watch the live console.

The wizard can be reopened from the Dashboard. Every setting remains editable from the **Settings**, **Persona**, and **Ollama** tabs.

### Desktop Features

- **Multiple bots:** each bot has a separate account, config, persona, memory, logs, and process. The app prevents two running bots from sharing one Steam account.
- **Test chat:** run the real persona, thinking, vision, and action-tag pipeline as either a DM or group chat without logging into Steam or touching memory.
- **Persona writer:** generate or improve the system prompt and personality with an installed model. Generated text is placed in the editor for review and never changes the masters section.
- **Background operation:** keep bots running in the system tray, auto-start selected bots when the app opens, and optionally launch the app at OS login.
- **Themes:** Dark, Light, Steam, Yuki's Theme, industrial FD-orange/white/metallic-silver Fergus Dynamics, Sakura, and High contrast.
- **Updates:** check releases, review the release page, and explicitly confirm before downloading or installing anything.

Use **Open data folder** on the Dashboard to find the selected bot's config, system prompt, memory, and logs. These files live in the app's user-data directory rather than beside the read-only AppImage or installed executable.

## Terminal Setup

### Requirements

- [Ollama](https://ollama.com/download) and at least one installed model.
- [Node.js](https://nodejs.org) 18 or newer, including npm.
- A Steam account for the bot.

### Quick Start

1. Download or clone the project.
2. Edit [`config.txt`](config.txt) with the Steam account, bot identity, models, and desired behavior.
3. Edit [`system prompt.txt`](system%20prompt.txt) with the persona and optional master SteamID64 values.
4. Start it:

   **Windows**

   ```bat
   start.bat
   ```

   **Linux**

   ```bash
   bash start.sh
   ```

The start scripts check Node.js and install the root dependency from `package.json` on first use. If Linux preserved the executable bit, `./start.sh` also works.

For a persona-only terminal test that never connects to Steam or memory, run:

```bash
node bot.js --playground
```

### Linux User Service

[`systemd/steam-llm-bot.service`](systemd/steam-llm-bot.service) is a template for running terminal mode as a user service. Copy it to `~/.config/systemd/user/`, edit its paths, then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now steam-llm-bot
```

Complete the first interactive Steam Guard login from a terminal before starting the service so the bot can save its refresh token.

## Conversation Behavior

### Group Modes

Each group can have its own mode:

| Mode | Behavior |
| --- | --- |
| `off` | Log messages but never reply automatically. |
| `alias` | Reply only when the bot name, a configured alias, or an actual @mention is used. |
| `smart` | Use social timing and conversation context to decide whether and when to speak. |
| `all` | Reply to every eligible live message when ready. |

Set the default with `Default group mode` in `config.txt`. At runtime, select a group and use `/groupmode off|alias|smart|all` in the bot console.

DM modes are `off`, `alias`, and `all`, controlled by `Default DM mode` or `/dmmode`.

### Steam Actions

When enabled, the model may add small tags that the framework converts into Steam features:

| Model output | Result |
| --- | --- |
| `[react:steamhappy]` | React to the message being answered. |
| `[me:waves]` | Send `/me waves` as a separate action line. |
| `[mention:Name]` | Mention a matching group member using their real Steam profile name. |
| `[spoiler:text]` | Send a working spoiler as its own message. |
| `[store:Game Name]` | Search the Steam store and send a URL that becomes a store card. |
| `:steamhappy:` | Use one owned emoticon when emoticons are enabled. |

`Steam actions` is the master switch. Reactions, `/me`, mentions, spoilers, store links, emoticons, and the typing indicator also have individual switches. Emoticons default to off because small models tend to overuse them.

Reactions rely on internal `steam-user` protocol support because the library has no public reaction API. A Steam protocol change may temporarily disable reactions without breaking normal chat. Mentions and spoilers fall back to plain text in DMs.

### Images and Thinking

- `Thinking = off|on|low|medium|high` controls supported reasoning models. Any leaked `<think>` blocks are removed before sending a reply.
- With `Vision = on`, a vision-capable reply model receives images directly.
- When the reply model cannot see images, `Vision model` can describe them first.
- Images are accepted from known Steam, Giphy, Imgur, and Discord hosts by default. `Allow any image host = on` broadens that trust boundary.
- Steam often sends pasted images separately from the surrounding text; the framework pairs recent images with the same sender's message.

### Memory and Friendships

- `Memory` stores useful facts and recent interactions.
- `Memory AI` allows a model to extract long-term facts in the background.
- `Friendships` maintains a relationship score from -100 to 100.
- `Friendship AI` changes that score through full-context semantic analysis, not keyword triggers or message counts.
- Friendship never grants owner or master authority.

### Reliability Behavior

- A successful Steam login saves a refresh token so Steam Guard normally needs to be completed only once.
- DMs received while the bot was offline are logged but not answered after startup.
- Each chat processes one selected message at a time. Messages arriving while that chat is already waiting or generating are logged but are not injected into the in-progress reply.
- Memory files are saved atomically and pending writes are drained during graceful shutdown.
- Old logs are removed according to `Log retention days`.
- The reconnect watchdog can exit a disconnected bot so systemd or another supervisor can restart it.

## Configuration

[`config.txt`](config.txt) is the normal runtime configuration. Edit only the value after each `=` and do not add quotes.

### Identity and Models

| Setting | Purpose |
| --- | --- |
| `Steam account name`, `Steam password` | Bot-account login. |
| `Steam Guard code` | Optional one-time code; normally leave blank and enter a fresh code when prompted. |
| `Bot name`, `Aliases` | Display identity and names that activate `alias` mode. |
| `Ollama URL` | Ollama endpoint, normally `http://127.0.0.1:11434`. |
| `Reply model` | Main conversational model. |
| `Timing model` | Social timing and reply-decision model. |
| `Fast reply model`, `Fast timing model` | Models used when fast mode is enabled. |
| `Memory model` | Background memory and relationship analysis. |
| `Safety model` | Optional safety-classification model used by the framework. |

### Resource Controls

| Setting | Default | Purpose |
| --- | --- | --- |
| `Keep model loaded` | `5m` | Ollama keep-alive duration; use `0` to unload immediately or `-1` to keep loaded. |
| `Keep only one model loaded` | `on` | Unload the previous framework model before switching to another. |
| `Unload models on exit` | `on` | Release this bot's models during graceful shutdown. |
| `Context size` | `8192` | Caps context memory use; blank uses the model/Ollama default. |
| `Reply timeout seconds` | `180` | Stops a stuck reply generation. |
| `Utility timeout seconds` | `60` | Stops a stuck timing, memory, or vision task. |
| `Reconnect watchdog minutes` | `10` | Exit after prolonged Steam disconnection so a service manager can restart it; `0` disables it. |
| `Log retention days` | `30` | Delete older chat and console logs at startup. |

Keeping one model loaded at a time and limiting context prevents reply, timing, memory, safety, and vision models from accumulating in RAM/VRAM and spilling into swap. A single model that is too large for the machine can still cause swapping; lower the context, use `Keep model loaded = 0`, or choose a smaller model.

### Groups, Friends, and Updates

| Setting | Values | Behavior |
| --- | --- | --- |
| `Auto join groups` | `off`, `masters`, `all` | Save invites only, auto-join invites from masters, or auto-join every invite. |
| `Friend requests` | `ask`, `ignore` | Notify masters for approval or leave requests untouched. Requests are never blindly auto-accepted. |
| `Check for updates` | `on`, `off` | Check GitHub releases at startup. |
| `Update source` | blank or `owner/repo` | Blank follows the original project; forks can follow their own releases. |

Steam's direct group-invite event does not identify the inviter. Therefore, `masters` can auto-join only invitations received through an identifiable master's DM; unidentified direct invitations remain in `/inbox`. Use `all` only if every invitation should be accepted automatically.

All available values and comments are documented directly in [`config.txt`](config.txt).

## Persona and Masters

[`system prompt.txt`](system%20prompt.txt) has four editable sections:

- `[SYSTEM PROMPT]` — general behavior and boundaries.
- `[PERSONALITY]` — voice, temperament, habits, and character details.
- `[MASTERS]` — one 17-digit SteamID64 per line. Leave blank for no master.
- `[MASTER BEHAVIOR]` — how the character treats verified masters.

Master status comes only from the configured SteamID64 list. A chat message claiming ownership never grants authority. [`Laborer [EXAMPLE].txt`](Laborer%20%5BEXAMPLE%5D.txt) demonstrates a more detailed character prompt.

## Commands

### Commands Sent Through Steam

These slash commands are accepted only from configured masters:

| Command | Purpose |
| --- | --- |
| `/inbox` | List saved group invitations. |
| `/inbox <number>` | Accept a saved invitation. |
| `/inbox clear` | Clear saved invitations. |
| `/joinchat help` | Show manual invite-link commands. |
| `/friend list` | List pending friend requests. |
| `/friend accept <id or number>` | Accept a pending request. |
| `/friend deny <id or number>` | Deny a pending request. |

When chat commands are enabled, the public prefix defaults to `!bot`:

- `!bot help`
- `!bot rules`
- `!bot ask <message>`

Changing `Chat command prefix` to `!` produces `!help`, `!rules`, and `!ask` instead.

### Bot Console

Use `/help` in the live console for the authoritative command list. Common commands include:

| Command | Purpose |
| --- | --- |
| `/status` | Show current framework status. |
| `/mode auto|manual` | Enable or pause automatic replies globally. |
| `/groupmode off|alias|smart|all` | Change the selected group's reply mode. |
| `/dmmode off|alias|all` | Change DM behavior. |
| `/list`, `/select <number>` | List and select recent chats. |
| `/say <message>` | Send text to the selected chat. |
| `/dm <person or SteamID64> \| <message>` | Send and select a DM. |
| `/reply [guidance]` | Force one AI reply to the selected chat. |
| `/ask <prompt>` | Test Ollama in the console without sending to Steam. |
| `/fake <reply with action tags>` | Test the complete outgoing action parser. |
| `/react <emoticon>` | React to the last received message in the selected chat. |
| `/memory ...`, `/friendship ...` | Inspect or maintain memory and friendship state. |
| `/mute`, `/unmute` | Ignore or restore a target. |
| `/fastmode`, `/delay` | Change runtime performance or artificial-delay behavior. |
| `/save`, `/exit` | Save or gracefully stop the bot. |

## Updates and Releases

By default, update checks read releases from the original project. Set `Update source = owner/repo` to follow a fork instead.

- **Terminal:** logs a notice and release URL when a newer version exists.
- **Desktop:** shows a banner with the release page and an optional **Download and install** button.
- **Windows:** downloads and launches the installer after confirmation.
- **Linux AppImage:** places the new AppImage beside the old one, keeps the old build for rollback, and restarts.
- **Other/source installs:** save the downloaded installer to the Downloads folder.

Downloads must come from the selected repository's GitHub release path. Size and GitHub-provided SHA-256 checksums are verified when available. Nothing is installed without a user click and confirmation.

Maintainers can publish installers by pushing a `v*` tag. The **Build installers** workflow builds the Windows `.exe` and Linux `.AppImage`, then attaches them to the GitHub release.

## Security and Local Data

- Prefer a dedicated Steam bot account.
- `config.txt` stores the Steam password in plain text; protect the bot's data directory accordingly.
- After a successful login, `steam-refresh-token.json` is sensitive and should be protected like a password.
- Configure masters by SteamID64, not display name.
- Leave `Allow any image host = off` unless arbitrary remote image downloads are required.
- Friend requests require a configured master's decision when `Friend requests = ask`.
- Two desktop bot processes cannot use the same Steam account simultaneously.

## Project Files

| Path | Purpose |
| --- | --- |
| `bot.js` | Main Steam bot and reply pipeline. |
| `config.txt` | Runtime settings and feature switches. |
| `system prompt.txt` | Persona, master IDs, and master behavior. |
| `lib/` | Ollama, vision, Steam action, text, persona, and update helpers. |
| `app/` | Electron desktop app and installer configuration. |
| `test/` | Node test suite. |
| `systemd/steam-llm-bot.service` | Example terminal-mode systemd unit. |
| `UPSTREAM-CHANGES.md` | Detailed inventory of improvements since the earlier upstream baseline. |

Runtime files such as logs, memory, refresh tokens, and saved invitations are intentionally excluded from distribution where applicable.

## Development

### Framework

```bash
npm install --no-package-lock --no-audit --no-fund
npm run check
npm test
```

### Desktop App

```bash
cd app
npm install
npm start
```

Build an installer with `npm run dist`. Linux builds the AppImage locally; the Windows installer should be built on Windows or through GitHub Actions. More packaging details are in [`app/README.md`](app/README.md).

## Troubleshooting

### Ollama Is Unavailable

Make sure Ollama is running and that `Ollama URL` points to it. Test the local server with:

```bash
ollama list
```

### The Bot Keeps Asking for Steam Guard

Complete one successful login and allow the framework to save `steam-refresh-token.json`. If Steam revokes the token, the framework deletes it and falls back to password login.

### Linux AppImage Will Not Open

Make the file executable. If Electron reports a sandbox or user-namespace error, launch it with `--no-sandbox` as shown in the install section.

### RAM or Swap Usage Is Too High

Keep `Keep only one model loaded = on`, lower `Context size`, set `Keep model loaded = 0`, and verify that the selected model itself fits in available RAM/VRAM.

### A Steam Action Does Not Appear

- Confirm `Steam actions` and that action's individual switch are on.
- Reactions require an emoticon name owned by the bot account and depend on experimental Steam protocol support.
- Emoticons are off by default.
- Mentions require a recently known group member and use their real Steam profile name.
- Store links require Steam's public store search to return a result.

### Windows Status

The framework itself has been used on Windows, but the current generated Windows installer and self-update path still need broader live testing. The installer is unsigned and will trigger SmartScreen.

## Change Inventory

For a detailed list of the v2.1.0–v2.2.0 additions, fixes, toggles, validation status, and remaining caveats, see [`UPSTREAM-CHANGES.md`](UPSTREAM-CHANGES.md).

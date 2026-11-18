# Changes Since Upstream

This document inventories the changes currently present in Hakai's fork but not yet in Moto's `upstream/master`.

## Baseline

Moto's current upstream already contains the README cleanup and the original v2.0.5 desktop GUI. The work described below covers v2.1.0 through v2.2.0.

## SWAP and Memory Issue

**v2.2.2 makes the memory limit a real hard cap.** Moto reported (Kubuntu) that the limiter did not hold and the PC was crippled. What was wrong in v2.2.1:

- The limit only unloaded the bot's *own* models before loading another one. A single model bigger than the limit still loaded, models other programs (or the test chat, which is a separate process) had loaded were ignored, and the size check used the file size on disk, which misses the context window.
- Old config files have no `Context size` line, so the "8192 default" only applied to fresh installs; everyone else got Ollama's default (32768 on many models), several GB more per model.
- Several requests could check the budget at the same moment and all decide they fit.
- A bad value like `Model memory limit = 4096MB` silently fell back to auto.
- If the desktop app crashed or was killed, bots it started kept running with no window to stop them.

What v2.2.2 does:

- `Model memory limit` (default auto = 35% of RAM) counts everything Ollama has loaded, measured from `/api/ps` (weights + context, RAM only, GPU memory excluded). Before a load, least recently used models are unloaded (the bot's own first, then any others); a model too big on its own is refused with a console message; after each request the real footprint is checked and the model is unloaded if it went over.
- New `Low memory guard` (default auto = 10% of RAM, at least 1 GB): when free memory drops below it, the bot unloads its models and refuses new model calls until memory frees up.
- Loads are serialized while a limit is on. Limits accept `6`, `6GB`, `512MB`, `25%`, `auto`, `off`; anything else logs a warning.
- `Context size` defaults to 8192 in code when the line is missing. `Keep model loaded` default is now 2m.
- The bot process runs with `--max-old-space-size=512` (desktop app, start scripts, systemd template, which also gets `MemoryMax=1G`).
- Bots started by the desktop app stop themselves when the app goes away. The playground `/exit` unloads models too.
- The app shows a one-time notice when closing the window leaves it running in the tray, and the Ollama tab lists what is loaded (RAM/GPU) with a "Free model memory" button and a note that Ollama is its own service that starts at boot on Linux (`sudo systemctl disable --now ollama` to stop that).

## Autostart and Background Running (v2.2.2)

Moto also reported that the app autostarted without being asked and turned itself back on after being turned off. What was wrong:

- "Keep running in the tray when the window is closed" was on by default, so clicking X only hid the window; the app and its bots kept running and looked like they had come back on their own.
- The "Open the app when I log in" entry was only ever removed by unticking the box in the app. If it was removed or switched off in the desktop's own autostart settings, the app still showed it as on, and an entry left by an older build was never cleaned up.

What v2.2.2 does:

- Everything that runs in the background is opt-in and off by default: tray mode, starting bots when the app opens, and opening the app at login. With them off, closing the window quits the app and stops every bot.
- At startup the app checks the real login entry. If it was removed or disabled outside the app (`Hidden=true`, `X-GNOME-Autostart-enabled=false`), the setting is turned off and the entry is never written back. If the setting is off, any leftover entry is deleted, and an app started by such an entry quits immediately.
- The app never installs or enables services. The systemd unit is a template that only runs if the user installs and enables it. Ollama's own boot service comes from Ollama's installer, not from this project.

## 1. Ollama, Model, and Image Improvements

- Added a centralized Ollama client with:
  - Request timeouts.
  - Model capability detection.
  - Thinking-level support.
  - Automatic removal of leaked `<think>` output.
  - Explicit model loading and unloading controls.
- Added `Thinking = off|on|low|medium|high`.
- Added image understanding:
  - Direct vision through the reply model when supported.
  - Optional separate vision model.
  - Steam, Giphy, Imgur, and Discord image handling.
  - Configurable image-count limit.
  - Known-host allowlist by default.
- Paired Steam's separately delivered image and text messages when they come from the same person.
- Prevented failed or processed images from remaining in memory as base64 data.
- Added separate reply and utility timeout settings.
- Added the SWAP/RAM controls described above.

## 2. Steam Chat Actions

Models can use lightweight tags in their responses:

- `[react:steamhappy]` — reacts to the answered message.
- `[me:waves]` — sends a proper `/me` action.
- `[mention:Name]` — creates an actual Steam mention in groups.
- `[spoiler:text]` — sends a functional Steam spoiler.
- `[store:Game Name]` — searches Steam and sends the store URL, producing a store card.
- Owned `:emoticons:` can optionally appear in normal messages.
- Typing indicators can be shown in DMs.

Additional handling:

- Mentions use the person's real Steam profile name.
- Loose matching lets `hakai` find a profile named `【HAKAI】`.
- Mentions of the bot activate it in `alias` group mode.
- The bot fetches the account's owned emoticon inventory from Steam.
- Garbled small-model emoticons are repaired when possible.
- Unknown emoticons are removed.
- At most one reaction and one emoticon survive per reply.
- Model-written brackets are escaped so they cannot become arbitrary Steam BBCode.
- Invented URL schemes and unusable mid-sentence slash commands are removed.
- Action tags tolerate common model mistakes such as `[/me:...]` and closing tags.
- Incoming reaction notifications are decoded and logged.
- Reaction sending degrades safely if Steam changes the underlying protocol.

Reactions use protected `steam-user` internals because the library does not provide a public reaction API, so they should be considered experimental.

## 3. Group and Friend Management

- Group invitations can:
  - Wait in `/inbox`.
  - Auto-join only when invited by a configured master.
  - Auto-join when invited by anyone.
- Friend requests are never blindly auto-accepted.
- Configured masters are notified about pending friend requests.
- Added master-only commands:
  - `/friend list`
  - `/friend accept <id or number>`
  - `/friend deny <id or number>`
- Bot mentions count as activation in `alias` mode.
- Invite-link scanning is restricted to configured masters.

## 4. Steam Login and Runtime Reliability

- Steam refresh tokens are stored after a successful login, avoiding repeated Steam Guard prompts.
- If a saved token is rejected, it is discarded and password login is retried.
- Added graceful `SIGTERM` and `SIGINT` shutdown:
  - State is saved.
  - Queued writes are drained.
  - Steam is logged out.
  - Ollama models are unloaded.
- Added a reconnect watchdog.
- Made memory-database saves atomic.
- Bounded processing queues.
- Added configurable log retention.
- Added unhandled-rejection logging.
- Sanitized display names.
- Fixed the first message after login being incorrectly discarded as stale.
- Prevented accumulated offline DMs from being answered after login.
- Updated DM sending to use the awaited modern Steam chat method.

## 5. Existing Behavior Fixes

- `Reply cooldown ms` now works; it was previously a no-op.
- `Fast mode` and `Performance mode` are no longer reset by restored memory state.
- Startup and default DM modes remain controlled by `config.txt`.
- Fixed literal `\n` appearing in generated prompts.
- Flattened multi-line console output correctly.
- Fixed log indentation.
- Removed duplicate/dead functions and incorrectly nested helpers.
- Fixed the `/reply` console command.
- `/list` now includes chats from which the bot has received messages even if it has not replied.
- Multi-character command prefixes work correctly, such as `!bot help` and `!bot ask`.

## 6. Test Chat and Playground

- Added `node bot.js --playground`, which runs the real reply pipeline without Steam.
- Supports:
  - Persona and system prompt.
  - Thinking.
  - Vision and image attachments.
  - Steam-action parsing.
  - DM-style and group-style testing.
- Never logs into Steam.
- Never reads or writes conversation memory.
- Desktop test-chat processes stop after ten idle minutes to release their model.

## 7. Desktop App Improvements

- Several independent bots can be managed simultaneously.
- Each bot has its own:
  - Steam account.
  - Configuration.
  - Persona.
  - Memory.
  - Logs.
  - Process.
- The app refuses to run two bots with the same Steam account.
- New bots can copy settings and persona from another bot without copying credentials or memory.
- Added a graphical test chat with image attachments and action-result chips.
- Added an AI persona writer:
  - Generate a persona from a description.
  - Improve an existing persona.
  - Write only the system-prompt and personality sections.
  - Never edit the masters section.
- Added seven themes:
  - Dark
  - Light
  - Steam
  - Yuki's Theme
  - Fergus Dynamics
  - Sakura
  - High contrast
- Added system-tray/background mode.
- Added per-bot automatic startup.
- Added launch-at-login support.
- Added single-instance handling.
- Added an application icon.
- Added a sample systemd service for terminal deployments.

## 8. Updates and Releases

- Update checks default to Moto's original repository rather than Hakai's fork.
- Forks can override the source with `Update source = owner/repo`.
- Terminal users receive an update notice only.
- Desktop users receive a **Download and install** button and must confirm before anything is installed:
  - Windows downloads and launches the installer.
  - Linux installs the new AppImage beside the old one, preserving the old version for rollback.
  - Source and non-AppImage runs save the installer to Downloads.
- Installer URLs must belong to the selected repository's GitHub release path.
- File size and GitHub checksum are verified when available.
- Pushing a `v*` tag makes CI publish the Windows and Linux installers as a GitHub release.

## Toggleability

There are 25 new configuration entries:

- 13 direct on/off switches.
- 3 mode selections.
- 9 model, resource-limit, timeout, or source fields.

### Individually Toggleable

- Vision
- Arbitrary image hosts
- Unload models on exit
- Entire Steam-actions system
- Reactions
- `/me` actions
- Mentions
- Spoilers
- Store links
- Emoticons
- Typing indicator
- Update checks

### Mode and Value Settings

- Thinking level
- Vision model
- Maximum images per message
- Model keep-alive duration
- Model memory limit
- Context size
- Reply timeout
- Utility timeout
- Auto-join policy
- Friend-request policy
- Update repository
- Reconnect watchdog
- Log retention

### Important Defaults

| Setting | Default |
| --- | --- |
| Thinking | `off` |
| Vision | `on` |
| Arbitrary image hosts | `off` |
| Model memory limit | `auto` |
| Unload models on exit | `on` |
| Context size | `8192` |
| Steam actions | `on` |
| Emoticons | `off` |
| Auto-join groups | `off` |
| Friend requests | Ask configured masters |
| Update checks | `on` |
| Update installation | Always requires confirmation |

The permanent bug fixes, refresh-token support, safe shutdown, and queue protections are not optional toggles.

## Verification

All 31 automated tests pass.

Live-tested functionality includes:

- Group images.
- Outgoing reactions.
- `/me` actions.
- Spoilers.
- Real highlighted mentions.
- Steam store cards.
- Group auto-join.
- `/friend list`.
- Update discovery, download, and checksum handling.

## Remaining Caveats

The following have not yet been completely live-tested:

- A real friend-request accept/deny lifecycle.
- Windows installer/update execution.
- Linux restarting directly into a downloaded AppImage.
- Long-duration SWAP telemetry under every possible model combination.
- A model spontaneously choosing a reaction tag without a forced test.

## Upstream Review Cleanup

Before opening the upstream pull request:

1. `bot.js` should have its line endings restored to match upstream. Its CRLF-to-LF normalization makes the raw PR appear much larger than the logical code change.
   - Raw diff: approximately 9,139 additions and 7,268 deletions.
   - Whitespace-adjusted diff: approximately 2,596 additions and 725 deletions across 25 files.
2. The README heading **New in this fork** should be renamed to something such as **Additional features** after upstreaming.
3. The upstream branch should be cleanly re-authored or squashed so Hakai is the commit author and Yuki appears in the `Co-authored-by` trailer.

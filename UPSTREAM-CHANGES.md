# Changes Since Upstream

This document inventories the changes currently present in Hakai's fork but not yet in Moto's `upstream/master`.

## Baseline

Moto's current upstream already contains the README cleanup and the original v2.0.5 desktop GUI. The work described below covers v2.1.0 through v2.2.0.

## SWAP and Memory Issue

**The identified SWAP issue is fixed at the code level.**

The problem was caused by the bot using several Ollama models—reply, timing, memory, safety, and vision—while leaving each model loaded for Ollama's default keep-alive period. Multiple models could accumulate in RAM/VRAM and spill into swap.

The framework now:

- Keeps only one Ollama model resident at a time by default.
- Unloads the previous model before switching models.
- Unloads the bot's models when the bot exits.
- Sets an 8192-token default context instead of potentially using Ollama's much larger model default.
- Stops idle desktop test-chat processes after ten minutes.
- Does not retain multi-megabyte base64 images in conversation state.
- Sends an explicit `keep_alive` value with every generation request.

This behavior has automated coverage. It prevents the specific multi-model accumulation bug, although one individually oversized model can still cause swapping. For aggressive memory conservation, set `Keep model loaded = 0`, lower `Context size`, or use a smaller model.

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
- Keep only one model loaded
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
| Keep only one model loaded | `on` |
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

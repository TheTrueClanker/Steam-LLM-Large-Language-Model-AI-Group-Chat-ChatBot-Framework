#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

pause_if_interactive() {
  if [ -t 0 ]; then
    printf "\nPress any key to close..."
    IFS= read -r -n 1 _
    printf "\n"
  fi
}

fail() {
  printf "\nERROR: %s\n" "$1"
  pause_if_interactive
  exit 1
}

printf "Ollama Steam Chatbot Framework\n"
printf "Location: %s\n\n" "$SCRIPT_DIR"

command -v node >/dev/null 2>&1 || fail "Node.js is not installed or is not available in PATH. Install Node.js 18 or newer, then run start.sh again."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf "0")"
if [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null; then
  fail "This framework requires Node.js 18 or newer. Update Node.js, then run start.sh again."
fi

command -v npm >/dev/null 2>&1 || fail "npm is not available in PATH. Reinstall or repair Node.js so npm is included."

[ -f "package.json" ] || fail "package.json is missing from: $SCRIPT_DIR"

if [ ! -f "node_modules/steam-user/package.json" ]; then
  printf "Dependencies are not installed on this computer yet.\n"
  printf "Installing them now from package.json...\n\n"

  npm install --no-package-lock --no-audit --no-fund
  NPM_EXIT=$?

  if [ "$NPM_EXIT" -ne 0 ]; then
    fail "npm could not install the framework dependencies. Check your internet connection and Node.js/npm installation."
  fi

  printf "\nDependencies installed for this computer.\n\n"
fi

printf "Starting bot...\n"
node --max-old-space-size=512 bot.js
BOT_EXIT=$?

# Exit code 20 means bot.js already displayed the Steam setup/login
# instructions and waited for a key itself.
if [ "$BOT_EXIT" -eq 20 ]; then
  exit 20
fi

printf "\n"
if [ "$BOT_EXIT" -ne 0 ]; then
  printf "Bot stopped because of an error. Exit code: %s\n" "$BOT_EXIT"
else
  printf "Bot stopped.\n"
fi

pause_if_interactive
exit "$BOT_EXIT"

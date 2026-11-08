#!/bin/sh
set -e # Exit immediately if anything below fails

# Recreate/overwrite APPEND_SYSTEM.md inside persistent volume on every container startup
mkdir -p /root/.pi/agent
cp /usr/local/share/pi/APPEND_SYSTEM.md /root/.pi/agent/APPEND_SYSTEM.md

# Copy keybindings into persistent volume on every startup
if [ -f "/usr/local/share/pi/keybindings.json" ]; then
    cp /usr/local/share/pi/keybindings.json /root/.pi/agent/keybindings.json
fi

# don't use 'pi install --local'. Without it packages install into named container volume
# and stay available no matter the content of /workspace volume
#
# `pi update --extension` is faster at startup if there is no update and the extension is already installed
#
# Installing here instead of in the image avoids copying packages into the named volume,
# which would need manual edits of settings.json.
# Packages removed from this list must be uninstalled manually from inside pi.
echo "Updating / Installing packages"
timeout 30s bash -c 'pi update --extension npm:pi-web-access || pi install npm:pi-web-access'
timeout 30s bash -c 'pi update --extension npm:pi-llama-cpp || pi install npm:pi-llama-cpp'

echo "Refreshing extensions from image cache"
rm -rf /root/.pi/agent/extensions
mkdir -p /root/.pi/agent/extensions
if [ -d "/usr/local/share/pi/extensions" ]; then
    cp -Rf /usr/local/share/pi/extensions/. /root/.pi/agent/extensions/
fi

echo "Refreshing skills from image cache"
rm -rf /root/.pi/agent/skills
mkdir -p /root/.pi/agent/skills
if [ -d "/usr/local/share/pi/skills" ]; then
    cp -Rf /usr/local/share/pi/skills/. /root/.pi/agent/skills/
fi

echo "Refreshing web search config from image cache"
# pi-web-access reads ~/.pi/web-search.json (outside the persistent volume),
# so copy it in on every startup like the other cached assets.
# Edit web-search.json in the repo and rebuild; live edits in the container get overwritten.
if [ -f "/usr/local/share/pi/web-search.json" ]; then
    cp /usr/local/share/pi/web-search.json /root/.pi/web-search.json
fi

echo "Try setting env var 'TAVILY_API_KEY'"
if [ -f "/root/.pi/agent/tavily_api_key" ]; then
    export TAVILY_API_KEY="$(cat /root/.pi/agent/tavily_api_key | tr -d '\r\n ')"
fi

# Point the llama-cpp server package at the local inference endpoint
export LLAMA_SERVER_URL="http://192.168.8.3:9931"

# Execute the original container command (normally `pi`)
exec "$@"

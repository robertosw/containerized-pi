#!/bin/sh
# Link the default pub cache location (~/.pub-cache) to the cache pub uses.
#
# Target resolution order: PUB_CACHE_DIR (explicit override) > PUB_CACHE (env).
# Both are expected to be configured on the host, otherwise flutter would not
# run correctly there either. The link is created at startup because the cache
# dir only exists at runtime.
#
# SOURCED from entrypoint.sh (not executed), so the PUB_CACHE export below
# reaches the pi process. Safe under the entrypoint's `set -e`. Misconfiguration
# prints an error but does not abort: pi must still start.

if [ -z "$PUB_CACHE_DIR" ]; then
    PUB_CACHE_DIR="$PUB_CACHE"
fi

if [ -z "$PUB_CACHE_DIR" ]; then
    echo "Error: PUB_CACHE is not set. Set PUB_CACHE (or PUB_CACHE_DIR) in the container env so ~/.pub-cache can be linked."
elif [ ! -d "$PUB_CACHE_DIR" ]; then
    echo "Error: pub cache dir '$PUB_CACHE_DIR' does not exist. Check the container env and mounted volumes."
else
    export PUB_CACHE="$PUB_CACHE_DIR"
    if [ -L /root/.pub-cache ]; then
        # existing symlink (correct or stale) — replace it
        ln -sfn "$PUB_CACHE_DIR" /root/.pub-cache
    elif [ ! -e /root/.pub-cache ]; then
        ln -s "$PUB_CACHE_DIR" /root/.pub-cache
    elif [ -d /root/.pub-cache ] && [ -z "$(ls -A /root/.pub-cache)" ]; then
        # empty real directory — safe to replace with the link
        rmdir /root/.pub-cache
        ln -s "$PUB_CACHE_DIR" /root/.pub-cache
    else
        echo "Warning: /root/.pub-cache is a non-empty directory; not replacing it with a link."
    fi
fi

FROM node:lts

# setup from https://pi.dev/docs/latest/containerization
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

# install pi
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# No WORKDIR: the launcher always passes --workdir (container paths mirror host names)

# Copy APPEND_SYSTEM into image asset cache
COPY APPEND_SYSTEM.md /usr/local/share/pi/APPEND_SYSTEM.md

# Copy local extensions into image asset cache
COPY extensions/ /usr/local/share/pi/extensions/

# Copy local skills into image asset cache
COPY skills/ /usr/local/share/pi/skills/

# Copy web-search.json (pi-web-access provider routing) into image asset cache
COPY web-search.json /usr/local/share/pi/web-search.json

# Copy keybindings into image asset cache
COPY keybindings.json /usr/local/share/pi/keybindings.json

# Copy the entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pi"]

FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

# upstream is checked out at the published release's immutable commit.
# Never copy the entire repository or media directories.
COPY upstream/index.html upstream/embed.html upstream/styles.css upstream/app.js upstream/settings.js upstream/resilience.js upstream/heic2any.min.js upstream/folderframe.config.json /srv/app/
COPY upstream/docs/images/folderframe-logo.png upstream/docs/images/folderframe-icon.png /srv/app/docs/images/
COPY upstream/LICENSE /usr/share/licenses/folderframe/LICENSE
COPY Caddyfile /etc/caddy/Caddyfile

RUN mkdir -p /media && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

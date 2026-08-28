FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

# Only the curated public app snapshot is included.
COPY app/index.html app/embed.html app/styles.css app/app.js app/settings.js app/resilience.js app/heic2any.min.js app/folderframe.config.json /srv/app/
COPY app/docs/images/folderframe-logo.png /srv/app/docs/images/folderframe-logo.png
COPY app/LICENSE /usr/share/licenses/folderframe/LICENSE
COPY Caddyfile /etc/caddy/Caddyfile

RUN mkdir -p /media && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

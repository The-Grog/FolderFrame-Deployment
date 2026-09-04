FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

# upstream is checked out at the published release's immutable commit.
# Never copy the entire repository or media directories.
COPY upstream/index.html upstream/embed.html upstream/styles.css upstream/app.js upstream/settings.js upstream/resilience.js upstream/heic2any.min.js /srv/app/
COPY upstream/folderframe.config.json /usr/share/folderframe/folderframe.config.json
COPY upstream/generate_thumbnails.py /usr/share/folderframe/generate_thumbnails.py
COPY upstream/docs/images/folderframe-logo.png upstream/docs/images/folderframe-logo-back.png upstream/docs/images/folderframe-icon.png /srv/app/docs/images/
COPY upstream/LICENSE /usr/share/licenses/folderframe/LICENSE
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /usr/bin/folderframe-entrypoint
COPY thumbnail_worker.py /usr/share/folderframe/thumbnail_worker.py

RUN apk add --no-cache jq python3 py3-pip py3-pillow \
    && python3 -m pip install --no-cache-dir --break-system-packages --no-deps pillow-heif==1.5.0 \
    && mkdir -p /media /config /run/folderframe \
    && chmod 0755 /usr/bin/folderframe-entrypoint \
    && chmod 0755 /usr/share/folderframe/thumbnail_worker.py \
    && chmod 0755 /usr/share/folderframe/generate_thumbnails.py \
    && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

VOLUME ["/config"]
EXPOSE 8080
ENTRYPOINT ["/usr/bin/folderframe-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

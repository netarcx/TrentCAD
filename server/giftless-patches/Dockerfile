# Custom Giftless image that adds real multipart-upload support to
# the LocalStorage backend. Upstream (0.6.2) ships with
# get_multipart_actions returning {} — so the multipart transfer
# adapter silently no-ops against the local filesystem and big files
# (>100 MB) get stuck on Cloudflare's tunnel body cap. See
# giftless/storage/local_storage.py header comment for the details.
#
# We don't fork the whole project — just COPY two patched .py files
# over the upstream image on top of it. Rebuilds in seconds and the
# diff against upstream is one `git diff` away.
FROM datopian/giftless:0.6.2

# COPY layout mirrors the in-container path under /app/.
COPY giftless/storage/local_storage.py    /app/giftless/storage/local_storage.py
COPY giftless/transfer/multipart.py        /app/giftless/transfer/multipart.py

# Bust any bytecode cache so the new sources are what uwsgi imports.
RUN find /app/giftless -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# The base image already sets the entrypoint / CMD; docker-compose
# overrides them with the actual uwsgi command, so nothing to do here.

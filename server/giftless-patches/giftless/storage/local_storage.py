"""Local storage implementation, for development/testing or small-scale
deployments.

FrameCAD patch (2026-05-22): adds real multipart-upload support so the
Git LFS `multipart-basic` transfer adapter works against the local
filesystem (upstream returned `{}` from `get_multipart_actions`, so
multipart silently fell back to the basic adapter and big files
choked on Cloudflare's 100 MB body cap). The patch:

  1. Implements `get_multipart_actions` to return real `parts`/`commit`/
     `abort` URLs pointing back at Giftless itself.
  2. Adds `put_part`, `commit_parts`, `abort_parts` storage methods that
     write each part to `<oid>.parts/<n>`, then concatenate-and-hash on
     commit (SHA-256 verified against the OID; mismatch deletes the
     output and 400s).
  3. Registers a `LocalMultipartView` Flask view that exposes
     `/<org>/<repo>/objects/storage/<oid>/parts/<n>` (PUT),
     `/.../commit` (POST), and `/.../abort` (DELETE), reusing the same
     `Permission.WRITE`-on-OID JWT auth the basic adapter already uses.

The view runs as a `ViewProvider` on the storage, so the existing
`MultipartTransferAdapter.register_views` (which already calls
`storage.register_views(app)` when the storage is a ViewProvider) wires
us up automatically — no transfer-adapter changes required.
"""
import hashlib
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, BinaryIO

from flask import Flask, Response, current_app, request, url_for
from flask_classful import route

from giftless.auth.identity import Permission
from giftless.exc import InvalidPayload
from giftless.storage import MultipartStorage, StreamingStorage, exc
from giftless.view import BaseView, ViewProvider

# Default part size when the transfer adapter doesn't pass one in
# (10 MiB matches the multipart adapter's own default). The CF tunnel
# caps proxied bodies at 100 MB, so anything under that is safe; we
# keep it generous-but-not-borderline to amortize per-part round-trips.
DEFAULT_PART_SIZE = 10 * 1024 * 1024

# Buffer size for stream copies on commit — larger than the default
# 16 KiB to reduce syscall overhead on multi-GB concatenations.
_COPY_BUF = 1 * 1024 * 1024


class LocalMultipartView(BaseView):
    """HTTP endpoints for the per-OID multipart upload protocol.

    Routes (under `route_base = "objects/storage"`, so they mount as
    `/<org>/<repo>/objects/storage/...`):

      PUT    /<oid>/parts/<int:part_num>   — receive one part
      POST   /<oid>/commit                 — assemble parts → final
      DELETE /<oid>/abort                  — drop partial upload

    All three reuse the same JWT scope (`Permission.WRITE` on the OID)
    so a single mint covers the entire upload session.
    """

    route_base = "objects/storage"

    def __init__(self, storage: "LocalStorage") -> None:
        self.storage = storage

    @route("/<oid>/parts/<int:part_num>", methods=["PUT"])
    def put_part(
        self, organization: str, repo: str, oid: str, part_num: int
    ) -> Response:
        self._check_authorization(
            organization, repo, Permission.WRITE, oid=oid
        )
        prefix = f"{organization}/{repo}"
        self.storage.put_part(prefix, oid, part_num, request.stream)
        return Response(status=200)

    @route("/<oid>/commit", methods=["POST"])
    def commit_parts(
        self, organization: str, repo: str, oid: str
    ) -> Response:
        self._check_authorization(
            organization, repo, Permission.WRITE, oid=oid
        )
        prefix = f"{organization}/{repo}"
        try:
            self.storage.commit_parts(prefix, oid)
        except exc.ObjectNotFoundError as e:
            raise InvalidPayload(str(e))
        except ValueError as e:
            # Hash mismatch — InvalidPayload returns 422 which git-lfs
            # surfaces as a real error rather than a generic 500.
            raise InvalidPayload(str(e))
        return Response(status=200)

    @route("/<oid>/abort", methods=["DELETE"])
    def abort_parts(
        self, organization: str, repo: str, oid: str
    ) -> Response:
        self._check_authorization(
            organization, repo, Permission.WRITE, oid=oid
        )
        prefix = f"{organization}/{repo}"
        self.storage.abort_parts(prefix, oid)
        return Response(status=200)

    @classmethod
    def get_part_url(
        cls, organization: str, repo: str, oid: str, part_num: int
    ) -> str:
        legacy = "Legacy" if current_app.config["LEGACY_ENDPOINTS"] else ""
        op_name = f"{legacy}{cls.__name__}:put_part"
        url: str = url_for(
            op_name,
            organization=organization,
            repo=repo,
            oid=oid,
            part_num=part_num,
            _external=True,
        )
        return url

    @classmethod
    def get_commit_url(
        cls, organization: str, repo: str, oid: str
    ) -> str:
        legacy = "Legacy" if current_app.config["LEGACY_ENDPOINTS"] else ""
        op_name = f"{legacy}{cls.__name__}:commit_parts"
        url: str = url_for(
            op_name,
            organization=organization,
            repo=repo,
            oid=oid,
            _external=True,
        )
        return url

    @classmethod
    def get_abort_url(
        cls, organization: str, repo: str, oid: str
    ) -> str:
        legacy = "Legacy" if current_app.config["LEGACY_ENDPOINTS"] else ""
        op_name = f"{legacy}{cls.__name__}:abort_parts"
        url: str = url_for(
            op_name,
            organization=organization,
            repo=repo,
            oid=oid,
            _external=True,
        )
        return url


class LocalStorage(StreamingStorage, MultipartStorage, ViewProvider):
    """Local storage implementation.

    This storage backend works by storing files in the local file
    system.  While it can be used in production, large scale
    deployment will most likely want to use a more scalable solution
    such as one of the cloud storage backends.
    """

    def __init__(self, path: str | None = None, **_: Any) -> None:
        if path is None:
            path = "lfs-storage"
        self.path = path
        self._create_path(self.path)

    def get(self, prefix: str, oid: str) -> BinaryIO:
        path = self._get_path(prefix, oid)
        if path.is_file():
            return path.open("br")
        else:
            raise exc.ObjectNotFoundError(f"Object {path} was not found")

    def put(self, prefix: str, oid: str, data_stream: BinaryIO) -> int:
        path = self._get_path(prefix, oid)
        directory = path.parent
        self._create_path(str(directory))
        with path.open("bw") as dest:
            shutil.copyfileobj(data_stream, dest)
            return dest.tell()

    def exists(self, prefix: str, oid: str) -> bool:
        path = self._get_path(prefix, oid)
        return path.is_file()

    def get_size(self, prefix: str, oid: str) -> int:
        if self.exists(prefix, oid):
            path = self._get_path(prefix, oid)
            return path.stat().st_size
        raise exc.ObjectNotFoundError("Object was not found")

    def get_mime_type(self, prefix: str, oid: str) -> str:
        if self.exists(prefix, oid):
            return "application/octet-stream"
        raise exc.ObjectNotFoundError("Object was not found")

    # ── Multipart upload ──────────────────────────────────────────────

    def put_part(
        self,
        prefix: str,
        oid: str,
        part_num: int,
        data_stream: BinaryIO,
    ) -> int:
        """Write a single part to `<oid>.parts/<part_num>`.

        Atomic: stream into `.tmp`, then `replace()` to the final part
        name. Re-uploads of the same part_num overwrite cleanly.
        """
        parts_dir = self._get_parts_dir(prefix, oid)
        parts_dir.mkdir(parents=True, exist_ok=True)
        part_path = parts_dir / f"{part_num:06d}"
        tmp_path = parts_dir / f"{part_num:06d}.{uuid.uuid4().hex}.tmp"
        try:
            with tmp_path.open("bw") as f:
                shutil.copyfileobj(data_stream, f)
                size = f.tell()
            os.replace(tmp_path, part_path)
            return size
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    def commit_parts(self, prefix: str, oid: str) -> int:
        """Concatenate all parts into the final object, SHA-256 verify
        against the OID, then drop the parts directory.

        Hash mismatch (= corrupted upload) raises `ValueError` so the
        view handler can return 422 to the client. The final file is
        written to a UUID-suffixed tempfile and only `os.replace()`d
        into place if the hash matches — so a partial / mismatched
        commit can never leave a bad object visible.
        """
        parts_dir = self._get_parts_dir(prefix, oid)
        if not parts_dir.is_dir():
            raise exc.ObjectNotFoundError(
                "No parts have been uploaded for this oid"
            )

        # Sort by numeric filename. Filter out any *.tmp leftovers.
        part_files = sorted(
            p
            for p in parts_dir.iterdir()
            if re.fullmatch(r"\d{6}", p.name)
        )
        if not part_files:
            raise exc.ObjectNotFoundError(
                "No completed parts found for this oid"
            )

        final_path = self._get_path(prefix, oid)
        final_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_final = final_path.parent / f".{oid}.{uuid.uuid4().hex}.tmp"

        sha = hashlib.sha256()
        total = 0
        try:
            with tmp_final.open("bw") as out:
                for part_path in part_files:
                    with part_path.open("br") as inp:
                        while True:
                            chunk = inp.read(_COPY_BUF)
                            if not chunk:
                                break
                            sha.update(chunk)
                            out.write(chunk)
                            total += len(chunk)
            if sha.hexdigest() != oid:
                raise ValueError(
                    f"hash mismatch: expected {oid}, got {sha.hexdigest()}"
                )
            os.replace(tmp_final, final_path)
        finally:
            if tmp_final.exists():
                tmp_final.unlink()

        # Drop the parts dir on success. Best-effort — a leftover dir
        # doesn't break correctness, the final file is the authority.
        shutil.rmtree(parts_dir, ignore_errors=True)
        return total

    def abort_parts(self, prefix: str, oid: str) -> None:
        """Drop the parts directory. Idempotent — missing is fine."""
        parts_dir = self._get_parts_dir(prefix, oid)
        if parts_dir.is_dir():
            shutil.rmtree(parts_dir, ignore_errors=True)

    def get_multipart_actions(
        self,
        prefix: str,
        oid: str,
        size: int,
        part_size: int,
        expires_in: int,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build the LFS multipart-basic actions dict.

        - Returns `{}` if the object is already on disk at the
          requested size (the transfer adapter takes that as
          "no upload needed").
        - Otherwise returns `actions.parts` (one entry per chunk),
          `actions.commit`, and `actions.abort`. URLs point back at
          Giftless's own `LocalMultipartView` (registered via
          `register_views` below). Auth headers get overlaid by
          `MultipartTransferAdapter.upload` after this returns.
        """
        if self.exists(prefix, oid) and self.get_size(prefix, oid) == size:
            return {}

        if part_size <= 0:
            part_size = DEFAULT_PART_SIZE

        # prefix arrives joined as "<org>/<repo>". Split for url_for —
        # the existing protocol guarantees a single slash separator.
        if "/" in prefix:
            organization, repo = prefix.split("/", 1)
        else:
            organization, repo = prefix, ""

        num_parts = (size + part_size - 1) // part_size if size else 0
        parts: list[dict[str, Any]] = []
        for i in range(num_parts):
            pos = i * part_size
            this_size = min(part_size, size - pos)
            parts.append(
                {
                    "href": LocalMultipartView.get_part_url(
                        organization, repo, oid, i
                    ),
                    "pos": pos,
                    "size": this_size,
                    "expires_in": expires_in,
                }
            )

        return {
            "actions": {
                "parts": parts,
                "commit": {
                    "method": "POST",
                    "href": LocalMultipartView.get_commit_url(
                        organization, repo, oid
                    ),
                    "expires_in": expires_in,
                },
                "abort": {
                    "method": "DELETE",
                    "href": LocalMultipartView.get_abort_url(
                        organization, repo, oid
                    ),
                    "expires_in": expires_in,
                },
            }
        }

    def get_download_action(
        self,
        prefix: str,
        oid: str,
        size: int,
        expires_in: int,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return {}

    def register_views(self, app: Flask) -> None:
        super().register_views(app)
        LocalMultipartView.register(app, init_argument=self)

    # ── Path helpers ──────────────────────────────────────────────────

    def _get_path(self, prefix: str, oid: str) -> Path:
        return Path(self.path) / prefix / oid

    def _get_parts_dir(self, prefix: str, oid: str) -> Path:
        """Per-OID staging dir for in-flight parts: <storage>/<prefix>/<oid>.parts/"""
        return Path(self.path) / prefix / f"{oid}.parts"

    @staticmethod
    def _create_path(spath: str) -> None:
        path = Path(spath)
        if not path.is_dir():
            path.mkdir(parents=True)

# Deploying and the overlay

How `sbin/updatewebui` puts this tree on a camera, and what the read-only
squashfs plus jffs2 overlay makes non-obvious. Both scripts carry the rest of
the reasoning in their own headers.

`sbin/updatewebui [options] [branch]` fetches a branch zip from GitHub and
installs `www/*` → `/var/www`, `sbin/*` → `/usr/sbin`, `bin/*` → `/usr/bin` —
the same payload `tools/build-dist.sh` hands buildroot. Default branch is
`master`; `--help` lists the options, `--dry-run` reports what would change,
`--restore` undoes an install. Edits to a running camera can also be made
directly under `/var/www/cgi-bin/` and `/usr/sbin/`.

`sbin/updatewebui` and `sbin/updatewebui-fetch` both open with the full
reasoning. What you need before getting there:

**The rootfs is a read-only squashfs pivoted to `/rom`, with a jffs2 overlay on
top.** Everything installed is an overlay copy hiding the firmware's own file
underneath, which outlives the firmware upgrade that would have replaced it
(#202). Three rules follow, and all three fail silently:

- Write only files that genuinely differ from `/rom`'s, drop the overlay copy of
  anything the firmware already has byte-identical, and prune entries this
  release no longer ships. On a current camera that is 37 overlay files, not 80.
- **Remove in the overlay's upper directory** (`upperdir=` from `/proc/mounts`;
  `/overlay/root` on 4.x, `/overlay` on the 3.10 out-of-tree overlayfs), never
  through the merged path — a plain `rm /var/www/x` writes a whiteout that hides
  the firmware's copy for good.
- **Unlink entries, never the directories holding them.** Removing a directory
  from the upper layer leaves the merged parent listing empty until the next
  reboot. The one sanctioned exit is `--restore`'s closing offer, on an explicit
  yes and paired with an immediate reboot.

**Nothing on the camera is touched until the download is fetched, verified and
unpacked.** The version this replaced wiped `/var/www` *before* checking
anything, so an unknown branch 404'd, unpacked nothing, and left the camera with
no WebUI at all and whiteouts over the firmware's copies.

**The put-back is planned before the removals.** Removing an overlay copy while
something still holds the file open leaves a merged entry the kernel goes on
serving for the removed inode, and nothing can `rename()` over one — it answers
`ESTALE`. The script running from the very path a `--restore` removes is exactly
that case, so what a run is about to write again is never removed first.

**`--restore` is the install's inverse, not a wipe.** It removes a path only
where the overlay copy still holds exactly what the manifest
(`/etc/webui/updatewebui.manifest`) says the install put there — the same path
holding anything else is work done on the camera since, and it stays — then
unpacks every `/etc/webui/updatewebui-local-*.tar.gz` oldest-first over what it
removed. So install → `--restore` is a round trip, and running `--restore` twice
does the same thing twice instead of eating on the second run what the first
handed back. The manifest is **emptied rather than deleted** at the end, because
"this script installed nothing" and "no version that kept a record has ever run
here" must not read alike: the second sends the next `--restore` down a blanket
sweep of `/var/www` that cannot tell your files from ours. `--no-backup` opts out
of both halves.

**The installer is not on the camera.** `tools/build-dist.sh` renames
`sbin/updatewebui-fetch` onto `sbin/updatewebui` in the payload, so the tarball
buildroot fetches carries the stub under the name people type and never the 48 KB
script. The full installer stays in git at `sbin/updatewebui`, because that path
is the URL the stub fetches — and the installer's skip is conditional on
`sbin/updatewebui-fetch` being present beside it, or a camera installing the
already-reduced shape would end up with no installer at all. Two reasons for the
split: the rootfs is a fixed-size squashfs partition where 48 KB stopped a board
building at all, and a script that installs itself is always one release behind.

**Two traps that are invisible until they bite.** `grep -f` with an **empty**
pattern file — busybox reads it as *match everything*, GNU as match nothing —
which is how these manifest lists get filtered. And the **variant** file set:
`BUILD_OPTION` in `/etc/os-release`, kept in step with the fixup lists in
buildroot's `majestic-webui.mk`, means a standard build gets no
`wfb.cgi`/`p/fpv_common.cgi` and an FPV build no `telegram`/`openwall`, and a
stale overlay copy of a skipped file is pruned rather than reinstalled.

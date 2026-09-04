#!/usr/bin/haserl
<%in p/common.cgi %>
<%
# Restore Majestic's configuration file to the one the firmware shipped.
#
# The path still arrives in ?f= because that is the link config.cgi
# writes, but it is now checked against the one file this page offers rather
# than used as given. Taken as given, a single request restored /rom's copy of
# whatever it named over the live one, and /rom holds every file the firmware
# ships - most of them nothing to do with this page and a good deal more
# consequential than a video setting.
config=$(get_config)
rom=$(get_config /rom)

[ "$GET_f" = "$config" ] || set_error_flag "Nothing to restore."
[ -f "$rom" ] || set_error_flag "The firmware has no copy of ${config} to restore."
[ -n "$error" ] && redirect_back

# Where a write to / physically lands. The rootfs is a read-only squashfs
# pivoted to /rom with a writable overlay on top, so restoring by copying
# /rom's file back leaves an overlay copy that hides the firmware's own file
# for good - including the newer one the next firmware upgrade delivers (#202).
# Taking the overlay copy away instead leaves the firmware's file showing
# through, which is what a reset to defaults means on this filesystem, and it
# leaves the page's "changes from defaults" diff genuinely empty afterwards.
#
# Only on the 4.x "overlay". The 3.10 out-of-tree "overlayfs" goes on serving a
# cached merged view of a directory whose upper layer was edited underneath it,
# and writing the file back through the merged path in the same request then
# lands ovl_rename on a stale dentry - a kernel warning out of drop_nlink, on a
# T31, first time it was tried. There the file is simply written the ordinary
# way below and the overlay copy stays, exactly as it did before.
upper=$(awk '$2 == "/" && $3 == "overlay" {
	n = split($4, o, ",")
	for (i = 1; i <= n; i++)
		if (o[i] ~ /^upperdir=/) { print substr(o[i], 10); exit }
}' /proc/mounts)
[ -n "$upper" ] && [ -d "$upper" ] && [ "$upper" != "/" ] || upper=

settle() {
	sync
	[ -w /proc/sys/vm/drop_caches ] && echo 3 > /proc/sys/vm/drop_caches
	return 0
}

# The firmware's file at $1, atomically and without widening the mode. cp
# settles the mode from the umask this process happened to inherit, which is
# not the same on every build - measured at 0077 on two cameras and 0022 on a
# third, where the restore turned a 0600 file that can hold cleartext stream
# credentials into a 0644 one. The mode the file already had is the mode it
# keeps, and it is set on the temporary file before any content goes into it.
put_rom() {
	local dst="$1"
	local mode=$(stat -c%a "$dst" 2>/dev/null)
	local tmp="${dst}.restore.$$"
	local rc
	[ -n "$mode" ] || mode=$(stat -c%a "$rom")
	rm -f "$tmp"
	touch "$tmp" && chmod "$mode" "$tmp" && cat "$rom" > "$tmp" &&
		mv "$tmp" "$dst"
	rc=$?
	rm -f "$tmp"
	return $rc
}

# The removal is made in the overlay's own directory, never through the merged
# path: rm "$config" writes a whiteout, which hides the firmware's copy instead
# of revealing it, and Majestic would then come up on its built-in defaults
# rather than on the ones this board was shipped with. The file cannot go
# missing in between either - the lower layer is what is left holding it.
if [ -n "$upper" ] && [ -f "${upper}${config}" ]; then
	rm -f "${upper}${config}"
	settle
	# If the merged view has not caught up, put the content back where it was
	# taken from rather than writing through the merged path: one request that
	# touches both is the mixture the comment above is about.
	cmp -s "$rom" "$config" || { put_rom "${upper}${config}"; settle; }
fi

cmp -s "$rom" "$config" || put_rom "$config"
sync
cmp -s "$rom" "$config" || redirect_back "danger" "Cannot restore ${config}!"

# Restoring the file is only half of it: see majestic_reload in p/common.cgi
# for what the other half is and why leaving it out loses the reset entirely.
if majestic_reload; then
	redirect_back "success" "${config} restored to firmware defaults. Majestic is picking them up now, so video restarts in a moment."
else
	redirect_back "warning" "${config} restored to firmware defaults, but Majestic is not running to be told. It will read the file when it next starts."
fi
%>

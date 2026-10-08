#!/bin/sh
# How big is the camera's flash?
#
# Sourced, never executed, for the reason p/majestic.sh gives. Two callers ask
# and must not answer differently: update_caminfo in p/common.cgi, which the
# Dashboard's Storage card prints, and /usr/sbin/openwall, which uploads the
# figure to openipc.org.
#
# Both used to add up the size of every partition. That is the chip only when
# the partitions tile it end to end, and mtdparts is free to define ones that
# overlap -- a `size@offset` span over kernel and rootfs, a whole-chip "all" --
# which then count twice. A 16 MB gk7205v500 was reported as 29 MB (#642).
#
# A chip is as big as the furthest partition end on it, so that is what this
# measures, per chip, and adds the chips. The kernel gives each partition's
# offset in sysfs; the 3.x kernels some boards still run do not, and there the
# offsets are rebuilt from the mtdparts= the kernel itself parsed them from.
# Only with neither does it fall back to the sum, which is exact for the
# ordinary end-to-end layout and is all that is left to go on.

# flash_bytes [sysroot]   total flash in bytes, or nothing when there is none
#
# sysroot prefixes /sys and /proc, for tests/flash-size.test.js.
flash_bytes() {
	local root="$1" d i=0 off chip
	while [ -d "$root/sys/class/mtd/mtd$i" ]; do
		d="$root/sys/class/mtd/mtd$i"
		i=$((i + 1))
		case "$(cat "$d/type" 2>/dev/null)" in
			nor | nand | mlc-nand) ;;
			*) continue ;;
		esac
		off=$(cat "$d/offset" 2>/dev/null)
		chip=-
		[ -e "$d/device" ] && chip=$(readlink -f "$d/device")
		printf '%s %s %s\n' "${chip:--}" "${off:--}" "$(cat "$d/size")"
	done | awk -v cmdline="$(cat "$root/proc/cmdline" 2>/dev/null)" '
		# memparse: decimal or 0x hex, then an optional k/m/g
		function num(s,   n, m, c, i) {
			m = 1
			c = tolower(substr(s, length(s)))
			if (c == "k") m = 1024; else if (c == "m") m = 1048576; else if (c == "g") m = 1073741824
			if (m > 1) s = substr(s, 1, length(s) - 1)
			n = 0
			if (tolower(substr(s, 1, 2)) == "0x") {
				for (i = 3; i <= length(s); i++)
					n = n * 16 + index("0123456789abcdef", tolower(substr(s, i, 1))) - 1
			} else n = s + 0
			return n * m
		}
		# Lay the partitions out the way the kernel does: each one starts
		# where the last ended unless it names an @offset. Every size is the
		# one sysfs reports, which is how a "-" remainder resolves; a size the
		# command line spells out must agree, or the mtdN-to-partition
		# pairing is not the one assumed and nothing here is trusted.
		function rebuild(   t, nt, spec, devs, nd, j, parts, np, p, s, at, k, pos, dev) {
			spec = ""
			nt = split(cmdline, t, " ")
			for (j = 1; j <= nt; j++)
				if (index(t[j], "mtdparts=") == 1) spec = substr(t[j], 10)
			if (spec == "") return 0
			k = 0
			nd = split(spec, devs, ";")
			for (j = 1; j <= nd; j++) {
				dev = substr(devs[j], 1, index(devs[j], ":") - 1)
				np = split(substr(devs[j], index(devs[j], ":") + 1), parts, ",")
				pos = 0
				for (p = 1; p <= np; p++) {
					if (++k > NR) return 0
					s = parts[p]
					sub(/\(.*/, "", s)
					at = index(s, "@")
					if (at) { pos = num(substr(s, at + 1)); s = substr(s, 1, at - 1) }
					if (s != "-" && num(s) != size[k]) return 0
					off[k] = pos
					chip[k] = dev
					pos += size[k]
				}
			}
			return k == NR
		}
		{ chip[NR] = $1; off[NR] = $2; size[NR] = $3; if ($2 == "-") nooff = 1 }
		END {
			if (!NR) exit
			if (nooff && !rebuild()) {
				for (i = 1; i <= NR; i++) total += size[i]
				print total
				exit
			}
			for (i = 1; i <= NR; i++)
				if (off[i] + size[i] > end[chip[i]]) end[chip[i]] = off[i] + size[i]
			for (c in end) total += end[c]
			print total
		}'
}

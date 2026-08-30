#!/bin/sh
# SD-card backend: JSON status (GET) + management ops (POST).
# GET  ?rec=<dir>  -> {present,device,target,model,...,sizeBytes,fs,mounted,
#                      mountpoint,totalKb,usedKb,availKb,recBytes,mkfs:[...],
#                      health,fsErrors:[...]}
# POST op=format|mount|unmount|fsck [fs=vfat] -> {ok,error,log}
#
# `health` is the one judgement this endpoint makes, and it is made here rather
# than in each page because two pages ask the same question from different
# sides. One of:
#
#   absent       no card in the slot
#   unformatted  a card with no partition table and nothing readable on it.
#                A card that has stopped storing data reads exactly like this,
#                which is why do_format verifies its own writes instead of
#                trusting the exit status of fdisk and mkfs.
#   unreadable   a partition is there but no filesystem can be read off it —
#                either never formatted, or damaged past recognition
#   unmounted    a filesystem is there, nothing has mounted it
#   readonly     mounted read-only: the card CANNOT be recorded to, whatever
#                the free space says. Usually the kernel's own doing —
#                `errors=remount-ro` drops a vfat card to read-only the moment
#                the FAT stops making sense, and df keeps reporting the space
#                that was free when it happened.
#   ok           mounted read-write

DEV=/dev/mmcblk0
SYS=/sys/block/mmcblk0

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }
json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
json_log() { printf '%s' "$1" | tr -d '\000-\010\013-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""}{print (NR>1?"\\n":"") $0}'; }
sysf() { cat "$SYS/device/$1" 2>/dev/null; }

# Append one line to the op log shown in the browser. `L="${L}x\n"` does not
# interpret the escape in POSIX sh, so what reached the page was a literal
# backslash-n between every line; the newline has to be a real one for
# json_log's awk to turn it into a JSON escape.
logln() { L="$L$1
"; }

# Said whenever something this script wrote comes back different. A card in
# this state reports no I/O error at all — it acknowledges every write and
# returns plausible-looking garbage — so nothing but a cold read-back catches
# it, and no amount of reformatting will fix it.
UNSTORED="the card did not keep what was written to it, so it cannot be formatted here. The card (or the slot) is failing and needs replacing."

# Make the next read come from the card rather than the page cache. This is
# defence in depth, not the whole defence: the kernel invalidates a block
# device's cache when its last opener closes it, so a fresh dd or blkid is
# normally cold already — but "normally" stops holding the moment something
# (the automount, say) keeps the device open. When it cannot be done the log
# says so, rather than letting a check look colder than it was.
uncache() {
	sync && echo 1 > /proc/sys/vm/drop_caches 2>/dev/null ||
		logln "# note: could not flush caches, the checks below may be reading cached data"
}

# Is there a partition table on sector 0? The 0x55AA signature at offset 510
# and a non-empty type byte in the first entry at 450. The signature alone will
# not do: a vfat boot sector ends in 0x55AA as well, so a card carrying a bare
# filesystem and no table at all would pass a signature-only test.
#
# Three outcomes, because "could not look" is not "looked and found nothing":
# 0 a table is there, 1 there is not, 2 the reads came back empty and the test
# never ran. The caller reports 2 into the log and carries on — the write probe
# below is what actually decides whether the card is keeping anything.
mbr_ok() {
	sig=$(dd if="$1" bs=1 skip=510 count=2 2>/dev/null | od -An -tx1 | tr -d ' \n')
	typ=$(dd if="$1" bs=1 skip=450 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
	[ -n "$sig" ] && [ -n "$typ" ] || return 2
	[ "$sig" = "55aa" ] && [ "$typ" != "00" ]
}

# Does this card keep a write at all? Stamp the partition's first sector and
# read it back cold. This is a fact measured about the card rather than an
# inference from the exit status of the tool that wrote it, and — unlike
# comparing the volume IDs of two formats — it does not care how closely
# together they happen.
#
# It is the check that catches a card gone read-only in hardware, which is the
# ordinary way an SD card ends its life: the write is dropped without complaint
# and the filesystem that was already there reads back intact, so every test
# that only asks "is there a filesystem?" says yes.
#
# The stamp lands on the sector mkfs is about to overwrite, so a format that
# fails after this point leaves the old filesystem damaged. Formatting was the
# request; the old filesystem was forfeit either way.
#
# It is minted per run (probe_new), because a format that aborted earlier can
# have left one of these behind: a fixed string would then be found on the card
# without this run having written it, and a card that has stopped taking writes
# in the meantime would read as one that took this one.
probe_new() {
	PROBE="MJ-PROBE $$ $(date +%s) $(dd if=/dev/urandom bs=6 count=1 2>/dev/null |
		od -An -tx1 | tr -d ' \n')"
}
probe_write() { printf '%s' "$PROBE" | dd of="$1" bs=512 count=1 2>/dev/null; }
probe_seen() { [ "$(dd if="$1" bs=1 count=${#PROBE} 2>/dev/null)" = "$PROBE" ]; }

# Kernel complaints about this card, newest last. Corroborating detail only:
# the ring buffer is small and chatty (on hi3516av300 the CMA allocator alone
# pushes a card error out of it within minutes), so finding nothing here proves
# nothing and must never be rendered as a clean bill of health. Two greps
# rather than one so a timeout on some other block device cannot be reported as
# an SD-card fault.
fs_errors() {
	dmesg 2>/dev/null | grep -E 'mmcblk|mmc[0-9]' |
		grep -iE 'error|fail|timeout|corrupt|read-only|remount' | tail -n 3
}

# fs_errors as a JSON array body. The while loop is the right-hand side of a
# pipe, so `i` lives in that one subshell and survives across iterations.
json_errs() {
	i=0
	fs_errors | while IFS= read -r ln; do
		[ "$i" = 0 ] || printf ','
		i=1
		printf '"%s"' "$(json_str "$ln")"
	done
}

# the active target partition/device and its conventional mount point
target() { if [ -b "${DEV}p1" ]; then printf '%sp1' "$DEV"; else printf '%s' "$DEV"; fi; }

mkfs_list() {
	out=""
	for fs in vfat ext4 exfat; do
		command -v "mkfs.$fs" >/dev/null 2>&1 && out="$out${out:+,}\"$fs\""
	done
	printf '%s' "$out"
}

get_info() {
	if [ ! -b "$DEV" ]; then printf '{"present":false,"health":"absent","fsErrors":[],"mkfs":[%s]}' "$(mkfs_list)"; return; fi
	t=$(target); base=${t##*/}
	[ -b "${DEV}p1" ] && partd=true || partd=false
	size=$(( $(cat "$SYS/size" 2>/dev/null || echo 0) * 512 ))
	mp=$(awk -v d="$t" '$1==d{print $2; exit}' /proc/mounts)
	# busybox blkid only reports UUID, so take the fs type from the mount table
	# when mounted; otherwise probe blkid (formatted vs unformatted).
	if [ -n "$mp" ]; then
		fs=$(awk -v d="$t" '$1==d{print $3; exit}' /proc/mounts)
	else
		bt=$(blkid "$t" 2>/dev/null)
		fs=$(printf '%s' "$bt" | sed -n 's/.*TYPE="\([^"]*\)".*/\1/p')
		[ -z "$fs" ] && [ -n "$bt" ] && fs="formatted"
	fi
	# A card mounted read-only cannot be recorded to, and nothing else on this
	# page can tell you that: df still reports the space that was free when the
	# kernel gave up on it. The mount options are field 4 and the flag is a
	# whole comma-separated word — matching a bare substring would find the
	# "ro" in `errors=remount-ro` on every healthy vfat mount.
	ro=false
	if [ -n "$mp" ]; then
		opts=$(awk -v d="$t" '$1==d{print $4; exit}' /proc/mounts)
		case ",$opts," in *,ro,*) ro=true;; esac
	fi
	mounted=false; total=0; used=0; avail=0; rec=0
	if [ -n "$mp" ]; then
		mounted=true
		set -- $(df -k "$mp" 2>/dev/null | awk 'NR==2{print $2, $3, $4}')
		total=${1:-0}; used=${2:-0}; avail=${3:-0}
		if [ -n "$GET_rec" ] && [ -d "$GET_rec" ]; then
			case "$GET_rec" in "$mp"|"$mp"/*) rec=$(( $(du -sk "$GET_rec" 2>/dev/null | cut -f1) * 1024 ));; esac
		fi
	fi
	printf '{"present":true,"device":"%s","target":"%s","mountpoint":"%s","mounted":%s,"partitioned":%s,' \
		"$DEV" "$t" "$(json_str "${mp:-/mnt/$base}")" "$mounted" "$partd"
	printf '"model":"%s","cardtype":"%s","manfid":"%s","oemid":"%s","date":"%s","serial":"%s",' \
		"$(json_str "$(sysf name)")" "$(json_str "$(sysf type)")" "$(json_str "$(sysf manfid)")" \
		"$(json_str "$(sysf oemid)")" "$(json_str "$(sysf date)")" "$(json_str "$(sysf serial)")"
	canfsck=false; command -v "fsck.$fs" >/dev/null 2>&1 && canfsck=true
	if [ "$ro" = true ]; then health=readonly
	elif [ "$mounted" = true ]; then health=ok
	elif [ -n "$fs" ]; then health=unmounted
	elif [ "$partd" = true ]; then health=unreadable
	else health=unformatted
	fi
	# Only scraped when something is wrong with the card. This endpoint is
	# polled every 5 s by the SD-card page, and dmesg is 80 KB on a running
	# camera — no reason to walk it while the card is healthy.
	errs=""
	case "$health" in readonly|unreadable) errs=$(json_errs);; esac
	printf '"sizeBytes":%s,"fs":"%s","totalKb":%s,"usedKb":%s,"availKb":%s,"recBytes":%s,"canFsck":%s,' \
		"$size" "$(json_str "$fs")" "$total" "$used" "$avail" "$rec" "$canfsck"
	printf '"health":"%s","fsErrors":[%s],"mkfs":[%s]}' "$health" "$errs" "$(mkfs_list)"
}

# Ensure the /dev/mmcblk0p1 node exists: the kernel may know the partition
# (in /proc/partitions) before mdev has created the device node. mdev -s makes
# it (and fires the OpenIPC SD automount rule).
ensure_node() {
	[ -b "${DEV}p1" ] && return 0
	i=0
	while [ ! -b "${DEV}p1" ] && [ "$i" -lt 10 ]; do
		mdev -s 2>/dev/null
		[ -b "${DEV}p1" ] && break
		sleep 1; i=$((i + 1))
	done
	[ -b "${DEV}p1" ]
}

do_format() {
	fs="${POST_fs:-vfat}"
	case "$fs" in vfat|ext4|exfat) ;; *) err="unsupported filesystem"; return;; esac
	command -v "mkfs.$fs" >/dev/null 2>&1 || { err="mkfs.$fs not installed"; return; }
	umount /mnt/mmcblk0p1 2>/dev/null; umount "${DEV}p1" 2>/dev/null; umount "$DEV" 2>/dev/null
	# Look before writing, and look on every format rather than only the ones
	# that write: the kernel can be holding an mmcblk0p1 from an earlier boot
	# over a card whose sector 0 no longer has the table it came from, and it
	# was skipping the check on exactly that reading that let a card storing
	# nothing format "successfully" in the lab.
	uncache
	mbr_ok "$DEV"; st=$?
	# A table is written when the card has none, and also when the one the
	# kernel is holding is not on the card any more. That second case says
	# nothing about the card until something has been written to it — a healthy
	# card whose table was wiped out from under a mounted kernel needs its table
	# put back, not condemning.
	if [ "$st" != 0 ] || ! grep -q 'mmcblk0p1$' /proc/partitions; then
		logln "# partition ${DEV}"
		logln "$(printf 'o\nn\np\n1\n\n\nw\n' | fdisk "$DEV" 2>&1)"
		partprobe "$DEV" 2>/dev/null
		uncache
		mbr_ok "$DEV"; st=$?
	fi
	# Only now can a missing table mean something about the card: one was
	# written to it on this run and did not come back.
	case "$st" in
		1) err="$UNSTORED"; return;;
		2) logln "# note: could not read the partition table back to check it";;
	esac
	ensure_node || { err="the partition table was written but the kernel never created ${DEV}p1 — rebooting the camera will pick it up"; return; }
	umount "${DEV}p1" 2>/dev/null   # automount may have grabbed it
	probe_new
	probe_write "${DEV}p1"
	uncache
	probe_seen "${DEV}p1" || { err="$UNSTORED"; return; }
	logln "# mkfs.$fs ${DEV}p1"
	o=$(mkfs.$fs "${DEV}p1" 2>&1); rc=$?
	[ -n "$o" ] && logln "$o"
	[ "$rc" -eq 0 ] || { err="$(first_line "${o:-mkfs.$fs failed}")"; return; }
	uncache
	# Past the probe the card is known to be keeping writes, so nothing below
	# blames it. mkfs writes its superblock over the stamp, and blkid is judged
	# on its *output*, never its exit status: busybox blkid exits 0 for a blank
	# partition and for a device that does not exist at all, so `blkid || fail`
	# — which is what stood here — could never fail.
	if probe_seen "${DEV}p1" || [ -z "$(blkid "${DEV}p1" 2>/dev/null)" ]; then
		err="mkfs.$fs reported success but no filesystem was written"
		return
	fi
	mkdir -p /mnt/mmcblk0p1
	mount "${DEV}p1" /mnt/mmcblk0p1 2>/dev/null
	mountpoint -q /mnt/mmcblk0p1 || err="mount after format failed"
}

# What mount and umount say when they refuse is the whole diagnosis — a card
# whose filesystem has been destroyed fails with "Invalid argument", which is
# worth reporting verbatim rather than flattening to "mount failed".
first_line() { printf '%s' "$1" | sed -n '1p'; }

do_mount() {
	ensure_node
	t=$(target); base=${t##*/}; mkdir -p "/mnt/$base"
	logln "# mount $t /mnt/$base"
	o=$(mount "$t" "/mnt/$base" 2>&1)
	[ -n "$o" ] && logln "$o"
	mountpoint -q "/mnt/$base" || err="$(first_line "${o:-mount failed}")"
}

do_unmount() {
	t=$(target)
	logln "# umount $t"
	o=$(umount "$t" 2>&1) || err="$(first_line "${o:-unmount failed (in use?)}")"
	[ -n "$o" ] && logln "$o"
}

do_fsck() {
	t=$(target)
	fs=$(awk -v d="$t" '$1==d{print $3; exit}' /proc/mounts)
	[ -z "$fs" ] && fs=$(blkid "$t" 2>/dev/null | sed -n 's/.*TYPE="\([^"]*\)".*/\1/p')
	# busybox ships the generic `fsck` wrapper, which only execs a per-filesystem
	# helper; on a build without dosfstools there is no fsck.vfat for it to find.
	# The page hides the button in that case (canFsck), so this is the backstop.
	[ -n "$fs" ] || { err="no filesystem could be identified on the card — there is nothing to repair"; return; }
	command -v "fsck.$fs" >/dev/null 2>&1 || {
		err="this firmware has no fsck.$fs — the card cannot be repaired here"; return; }
	# The check needs the card offline, but leaving it that way turns a repair
	# into a second outage — a camera that was recording would go on not
	# recording until somebody noticed the Mount button. So put it back exactly
	# where it was, and only if it was mounted to begin with.
	was=$(awk -v d="$t" '$1==d{print $2; exit}' /proc/mounts)
	umount "$t" 2>/dev/null
	logln "# fsck.$fs $t"
	o=$(fsck -t "$fs" -y "$t" 2>&1); rc=$?
	logln "$o"
	if [ -n "$was" ]; then
		logln "# mount $t $was"
		m=$(mount "$t" "$was" 2>&1)
		[ -n "$m" ] && logln "$m"
		mountpoint -q "$was" || { err="checked, but the card would not mount again"; return; }
	fi
	[ "$rc" -le 1 ] || err="fsck reported errors"
}

if [ "$REQUEST_METHOD" = "POST" ]; then
	json_hdr
	L=""; err=""
	case "$POST_op" in
		format) do_format;;
		mount) do_mount;;
		unmount) do_unmount;;
		fsck) do_fsck;;
		*) err="unknown op";;
	esac
	if [ -z "$err" ]; then
		printf '{"ok":true,"log":"%s"}' "$(json_log "$L")"
	else
		printf '{"ok":false,"error":"%s","log":"%s"}' "$(json_str "$err")" "$(json_log "$L")"
	fi
	exit 0
fi

json_hdr
get_info

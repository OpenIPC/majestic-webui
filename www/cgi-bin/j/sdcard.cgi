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

# Stamp the partition and read it back, with the same three outcomes mbr_ok
# has and for the same reason: "could not look" is not "looked and found the
# wrong thing", and only the second is evidence against the card.
#
# A read that comes back EMPTY means the device node went away again under the
# mdev churn that dogs every step of a format, not that the card refused the
# write. Convicting on that put the harshest message this endpoint owns — your
# card is failing, replace it — in front of someone holding a perfectly good
# card, on roughly one format in five. So absence is retried, and a write that
# fails outright is retried too rather than being read back and blamed.
#
# A single mismatch is not enough to convict either, and this is the subtle
# half. Mid-churn the stamp can be written to one node and read back from
# another after the kernel has re-created the partition, so what returns is the
# sector that was already on the card — non-empty, and nothing like the stamp.
# On a freshly wiped card that is random bytes, which reads exactly like a card
# refusing writes. A card that has genuinely stopped taking them fails EVERY
# attempt, so requiring the mismatch to repeat separates the two at no cost to
# the diagnosis.
#
# 0 the stamp came back, 1 it repeatedly did not, 2 could not get a clean look.
probe_card() {
	pc_i=0
	pc_miss=0
	while [ "$pc_i" -lt 6 ]; do
		if ensure_node; then
			probe_new
			if probe_write "$1"; then
				uncache
				got=$(dd if="$1" bs=1 count=${#PROBE} 2>/dev/null)
				[ "$got" = "$PROBE" ] && return 0
				# Only count it against the card if the partition is still there
				# and full length now: a mismatch read across a node swap says
				# nothing about whether the card kept the write.
				if [ -n "$got" ] && node_ready; then
					pc_miss=$((pc_miss + 1))
					[ "$pc_miss" -ge 3 ] && return 1
				fi
			fi
		fi
		sleep 1
		pc_i=$((pc_i + 1))
	done
	[ "$pc_miss" -ge 3 ] && return 1
	return 2
}

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

# The node existing is not the same as the partition being usable, and waiting
# only for `-b` is what made formatting a blank card fail about one run in
# four. Writing a partition table makes the kernel drop and re-add the
# partition, and around that pair mdev can leave a node behind whose partition
# the kernel no longer has: it opens fine and every size query answers zero.
# That is what reaches mkfs as "image is too small" — a complaint it makes
# about a 59 GB card — and what reaches mount as a bare ENOENT on the device.
#
# So measure the partition instead of asking whether a filename exists: read
# its far end. A sector that comes back from the last block of the partition is
# proof the kernel has it at the size /sys claims, which is the thing mkfs and
# mount are each about to rely on.
node_ready() {
	[ -b "${DEV}p1" ] || return 1
	sz=$(cat "$SYS/mmcblk0p1/size" 2>/dev/null)
	case "$sz" in ''|*[!0-9]*) return 1;; esac
	[ "$sz" -gt 0 ] || return 1
	[ "$(dd if="${DEV}p1" bs=512 skip=$((sz - 1)) count=1 2>/dev/null | wc -c)" = 512 ]
}

# Ensure /dev/mmcblk0p1 is there and usable: the kernel knows the partition
# (it is in /proc/partitions and /sys) before the node exists in /dev.
#
# Make the node here, from the major:minor the kernel already publishes, rather
# than asking mdev for it. `mdev -s` was what stood here, and it is a rescan of
# every device in /sys that re-runs the hotplug rules for each — which for this
# partition means /lib/mdev/automount.sh, the script whose umount pass unmounts
# the card and rmdir's /mnt/mmcblk0p1. So the call made to recover from node
# churn was itself a generator of it, and every retry made the next step more
# likely to fail. mknod asks the kernel for nothing and disturbs nothing.
# Every loop here carries its own counter. `i` was shared, and ensure_node —
# which each of the retry helpers calls inside its own loop — resets it to 0 and
# counts it up again, so an outer loop's remaining attempts were whatever the
# inner one happened to leave behind. The retries added to ride out the hotplug
# churn could therefore be skipped by the settling they were waiting on.
ensure_node() {
	node_ready && return 0
	en_i=0
	while [ "$en_i" -lt 10 ]; do
		mm=$(cat "$SYS/mmcblk0p1/dev" 2>/dev/null)   # e.g. "179:1"
		case "$mm" in
			[0-9]*:[0-9]*)
				[ -b "${DEV}p1" ] ||
					mknod "${DEV}p1" b "${mm%%:*}" "${mm##*:}" 2>/dev/null
				;;
			*)
				# The kernel has no partition at all, not merely no node for
				# one: there is nothing in /sys to make a node from. It re-reads
				# the table only while nothing holds the disk open, and the
				# automount is exactly such a holder, so partprobe here can have
				# failed with EBUSY and left the kernel on its old idea of the
				# layout. Let go of the card and ask again.
				umount /mnt/mmcblk0p1 2>/dev/null
				umount "$DEV" 2>/dev/null
				partprobe "$DEV" 2>/dev/null
				;;
		esac
		node_ready && return 0
		sleep 1; en_i=$((en_i + 1))
	done
	node_ready
}

do_format() {
	fs="${POST_fs:-vfat}"
	case "$fs" in vfat|ext4|exfat) ;; *) err="unsupported filesystem"; return;; esac
	command -v "mkfs.$fs" >/dev/null 2>&1 || { err="mkfs.$fs not installed"; return; }
	umount /mnt/mmcblk0p1 2>/dev/null; umount "${DEV}p1" 2>/dev/null; umount "$DEV" 2>/dev/null
	# Always write the table. Format means erase, so there is no state of the
	# card that makes writing one wrong — and deciding *not* to write it was a
	# way to get this wrong. The test that guarded it read sector 0, and that
	# read can come back from the page cache rather than the card (uncache is
	# defence in depth, not a guarantee, once something holds the device open).
	# A stale-but-valid-looking table then skipped the partitioning entirely and
	# mkfs ran against whatever the kernel still believed the layout to be,
	# which is a format that "succeeds" onto a partition that is not there.
	#
	# Writing unconditionally also subsumes the case the guard was added for —
	# a kernel holding an mmcblk0p1 from an earlier boot over a card whose
	# sector 0 no longer has the table it came from — without having to
	# recognise it first.
	logln "# partition ${DEV}"
	logln "$(printf 'o\nn\np\n1\n\n\nw\n' | fdisk "$DEV" 2>&1)"
	partprobe "$DEV" 2>/dev/null
	uncache
	mbr_ok "$DEV"; st=$?
	# Now a missing table means something about the card: one was written to it
	# on this run and did not come back. Before the write it would have meant
	# only that the card had never been partitioned, which is why someone is
	# here in the first place.
	case "$st" in
		1) err="$UNSTORED"; return;;
		2) logln "# note: could not read the partition table back to check it";;
	esac
	ensure_node || { err="the partition table was written but the kernel never created ${DEV}p1 — rebooting the camera will pick it up"; return; }
	umount "${DEV}p1" 2>/dev/null   # automount may have grabbed it
	probe_card "${DEV}p1"; ps=$?
	case "$ps" in
		1) err="$UNSTORED"; return;;
		2) logln "# note: could not read the write probe back to check it";;
	esac
	logln "# mkfs.$fs ${DEV}p1"
	mkfs_settled
	[ -n "$o" ] && logln "$o"
	[ "$rc" -eq 0 ] || { err="$(first_line "${o:-mkfs.$fs failed}")"; return; }
	# Mounting IS the proof that a filesystem was written, and it is what the
	# caller wanted anyway — so ask that question first and ask no other.
	#
	# What stood here instead was a pair of cold reads of the raw partition
	# (probe_seen, then blkid) run immediately after mkfs. Every one of those
	# races the mdev remove/add pair that writing the filesystem sets off, and a
	# read landing in the gap reports a device that is briefly absent — which
	# this then announced as "mkfs reported success but no filesystem was
	# written", about a card carrying a perfectly good one. Between that and the
	# mount below, a blank card failed to format on roughly one attempt in four.
	logln "# mount ${DEV}p1 /mnt/mmcblk0p1"
	if mount_after_format; then
		[ -n "$o" ] && logln "$o"
		return
	fi
	[ -n "$o" ] && logln "$o"
	# It did not mount. Only now is it worth asking what mkfs actually left
	# behind, and only now is the answer worth trusting: mount_after_format has
	# spent its retries, so the node has stopped moving under us.
	#
	# blkid is judged on its *output*, never its exit status: busybox blkid
	# exits 0 for a blank partition and for a device that does not exist at all,
	# so `blkid || fail` — which this once was — could never fire. Nothing down
	# here blames the card: a card that failed the write probe was reported as
	# such above, and one that could not be probed at all was never convicted in
	# the first place.
	uncache
	if probe_seen "${DEV}p1" || [ -z "$(blkid "${DEV}p1" 2>/dev/null)" ]; then
		err="mkfs.$fs reported success but no filesystem was written"
		return
	fi
	err="$(first_line "${o:-mount after format failed}")"
}

# mkfs gets the same settle treatment as the probe above and the mount below,
# because it fails the same way for the same reason: "image is too small" is
# what mkfs.vfat says when the kernel hands it a partition that has momentarily
# gone to zero length, and it says it about a 59 GB card. node_ready() makes
# that rare rather than impossible — it proves the partition is there and full
# length, but cannot hold it that way across the exec that follows.
#
# Only the transient complaints are retried. Matching them by message is crude,
# and deliberately narrow for that reason: anything else mkfs says is a real
# refusal and is reported the first time, unretried. Sets `o` and `rc` for the
# caller, as the inline call it replaced did.
mkfs_settled() {
	mk_i=0
	while [ "$mk_i" -lt 5 ]; do
		if ensure_node; then
			o=$(mkfs.$fs "${DEV}p1" 2>&1); rc=$?
			[ "$rc" -eq 0 ] && return 0
			case "$o" in
				*"too small"*|*[Nn]"o such file"*|*"Invalid argument"*) ;;
				*) return 1;;
			esac
		else
			# Say what actually went wrong. Reporting this as "mkfs failed"
			# blames the one step that never got to run.
			o="the kernel did not settle on a partition to format — the table was written, so try the format once more"
		fi
		sleep 1
		mk_i=$((mk_i + 1))
	done
	rc=${rc:-1}
	return 1
}

# Mount the card we have just formatted, against a hotplug helper that is
# actively fighting us. Every partition re-read fires mdev, and the remove half
# of the pair runs /lib/mdev/automount.sh, whose my_umount both unmounts the
# card AND rmdir's /mnt/mmcblk0p1 — so a mount can fail with ENOENT on the
# directory created two statements earlier, or on a node mdev has dropped and
# not yet remade. Neither is a fault of the card, and reporting either to
# somebody who asked for a format is reporting the wrong thing: this was ~1 run
# in 4 on a perfectly good card.
#
# There is no lock to take against an asynchronous helper, so the honest
# approach is to keep asking until the kernel and mdev have settled and only
# then believe a failure. The add half of the same pair also mounts the card
# itself, which is why an already-mounted card counts as success here rather
# than as a competing attempt.
mount_after_format() {
	mt_i=0
	while [ "$mt_i" -lt 8 ]; do
		mountpoint -q /mnt/mmcblk0p1 && return 0
		if ensure_node; then
			mkdir -p /mnt/mmcblk0p1 2>/dev/null
			o=$(mount "${DEV}p1" /mnt/mmcblk0p1 2>&1)
			mountpoint -q /mnt/mmcblk0p1 && return 0
		fi
		sleep 1
		mt_i=$((mt_i + 1))
	done
	return 1
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

#!/bin/sh
# SD-card backend: JSON status (GET) + management ops (POST).
# GET  ?rec=<dir>  -> {present,device,target,model,...,sizeBytes,fs,mounted,
#                      mountpoint,totalKb,usedKb,availKb,recBytes,mkfs:[...]}
# POST op=format|mount|unmount|fsck [fs=vfat] -> {ok,error,log}

DEV=/dev/mmcblk0
SYS=/sys/block/mmcblk0

json_hdr() { printf 'HTTP/1.1 200 OK\nContent-Type: application/json\nCache-Control: no-store\n\n'; }
json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
json_log() { printf '%s' "$1" | tr -d '\000-\010\013-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""}{print (NR>1?"\\n":"") $0}'; }
sysf() { cat "$SYS/device/$1" 2>/dev/null; }

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
	if [ ! -b "$DEV" ]; then printf '{"present":false,"mkfs":[%s]}' "$(mkfs_list)"; return; fi
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
	printf '"sizeBytes":%s,"fs":"%s","totalKb":%s,"usedKb":%s,"availKb":%s,"recBytes":%s,"canFsck":%s,"mkfs":[%s]}' \
		"$size" "$(json_str "$fs")" "$total" "$used" "$avail" "$rec" "$canfsck" "$(mkfs_list)"
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
	if ! grep -q 'mmcblk0p1$' /proc/partitions; then
		L="${L}# partition ${DEV}\n"
		L="${L}$(printf 'o\nn\np\n1\n\n\nw\n' | fdisk "$DEV" 2>&1)\n"
		partprobe "$DEV" 2>/dev/null
	fi
	ensure_node || { err="partition node mmcblk0p1 was not created"; return; }
	umount "${DEV}p1" 2>/dev/null   # automount may have grabbed it
	L="${L}# mkfs.$fs ${DEV}p1\n"
	L="${L}$(mkfs.$fs "${DEV}p1" 2>&1)\n"
	blkid "${DEV}p1" >/dev/null 2>&1 || { err="format failed"; return; }
	mkdir -p /mnt/mmcblk0p1
	mount "${DEV}p1" /mnt/mmcblk0p1 2>/dev/null
	mountpoint -q /mnt/mmcblk0p1 || err="mount after format failed"
}

do_mount() {
	ensure_node
	t=$(target); base=${t##*/}; mkdir -p "/mnt/$base"
	mount "$t" "/mnt/$base" 2>/dev/null
	mountpoint -q "/mnt/$base" || err="mount failed"
}

do_unmount() {
	t=$(target)
	umount "$t" 2>/dev/null || err="unmount failed (in use?)"
}

do_fsck() {
	t=$(target)
	fs=$(awk -v d="$t" '$1==d{print $3; exit}' /proc/mounts)
	[ -z "$fs" ] && fs=$(blkid "$t" 2>/dev/null | sed -n 's/.*TYPE="\([^"]*\)".*/\1/p')
	command -v "fsck.$fs" >/dev/null 2>&1 || { err="no fsck tool for ${fs:-this filesystem}"; return; }
	umount "$t" 2>/dev/null
	L="${L}# fsck.$fs $t\n"
	o=$(fsck -t "$fs" -y "$t" 2>&1); rc=$?
	L="${L}${o}\n"
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

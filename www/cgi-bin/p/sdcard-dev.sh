#!/bin/sh
# Which MMC disk is the camera's SD card, and which controller its slot is on.
#
# Sourced, never executed, like p/majestic.sh: j/sdcard.cgi takes the card it
# manages from here and p/common.cgi the answer to "is there a card at all" for
# the menu, so the two cannot disagree about it.
#
# The card is not always mmcblk0. A camera whose card hangs off the SoC's second
# SD controller has none: the HI3516D_N81820 speed dome's built-in card is
# mmcblk1, and with the name fixed the SD card page called it absent while
# majestic recorded to it, and the menu hid Recordings and SD Card.
#
# SDC_SYS_BLOCK, SDC_MMC_HOST, SDC_MOUNTS and SDC_CMDLINE stand in for
# /sys/block, /sys/class/mmc_host, /proc/mounts and /proc/cmdline in
# tests/sdcard-device.test.js; nothing else sets them.

# The kernel's word for what sits on an MMC host: SD, MMC (eMMC) or SDIO.
sdc_type() { cat "$1/type" 2>/dev/null; }

# Print the card's disk name (mmcblkN) and succeed, or fail with nothing printed.
# Taken: the first whole MMC disk that is an SD card -- not an eMMC, whose user
# area a format would wipe, nor its boot and RPMB areas -- and that the camera is
# not running from (some boot from an SD; the same test /lib/mdev/automount.sh
# makes, by mount and by command line).
sd_card_name() {
	for cn_d in "${SDC_SYS_BLOCK:-/sys/block}"/mmcblk[0-9]*; do
		[ -e "$cn_d" ] || continue
		cn_n=${cn_d##*/}
		case "$cn_n" in *boot*|*rpmb*) continue ;; esac
		[ "$(sdc_type "$cn_d/device")" = MMC ] && continue
		grep -qsE "^/dev/${cn_n}(p[0-9]+)? /(rom)? " "${SDC_MOUNTS:-/proc/mounts}" && continue
		grep -qs "root=/dev/${cn_n}" "${SDC_CMDLINE:-/proc/cmdline}" && continue
		echo "$cn_n"
		return 0
	done
	return 1
}

# Print the mmc host the SD slot is on (mmcN) and succeed, or fail. The card's
# own host while there is a card; with none, the first host with nothing on it
# at all -- a host carrying SDIO (Wi-Fi) or an eMMC is not the slot, and
# re-probing it would take that device away. Which host is the slot is a
# property of the board, so it is never assumed to be mmc0.
sd_slot_host() {
	sh_card=$(sd_card_name) &&
		sh_host=$(readlink -f "${SDC_SYS_BLOCK:-/sys/block}/$sh_card/device" 2>/dev/null) &&
		[ -n "$sh_host" ] && { basename "$(dirname "$sh_host")"; return 0; }
	for sh_h in "${SDC_MMC_HOST:-/sys/class/mmc_host}"/mmc[0-9]*; do
		[ -e "$sh_h" ] || continue
		sh_busy=
		for sh_c in "$sh_h"/mmc[0-9]*:*; do
			[ -e "$sh_c" ] && sh_busy=1
		done
		[ -z "$sh_busy" ] && { basename "$sh_h"; return 0; }
	done
	return 1
}

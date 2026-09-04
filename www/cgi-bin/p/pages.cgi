#!/usr/bin/haserl
<%
# pages.cgi -- the one place a page's name is written.
#
# p/header.cgi renders the nav bar from this file, and every page's <h2> and
# browser title default to the same row, so the word in the menu and the word
# on the page cannot disagree. They used to, because each name was written
# twice: once as nav markup and once as a page_title= line at the top of the
# page. Across a month of renames nine of them drifted apart -- the bar said
# Live, Network, Config file, Ntfy while the pages called themselves Live View,
# Network Settings, Configuration File, Ntfy Notifications.
#
# A `case` rather than a $var lookup, deliberately: page names contain hyphens,
# which are not legal in a shell variable name, so a variable table would need
# either an eval or a second spelling of every name. `case` needs neither, and
# called inline from a template block it forks nothing.
#
# tools/lint-templates.sh gates both directions -- a nav href with no row here,
# or a page with neither a row nor its own page_title=, fails the build.

# page_label <pagename>   the word the menu uses, and the page's own heading
page_label() {
	case "$1" in
	# Viewing
	dashboard)      printf '%s' "Dashboard" ;;
	live)           printf '%s' "Live" ;;
	recordings)     printf '%s' "Recordings" ;;
	# Camera
	camera)         printf '%s' "Settings" ;;
	stream-urls)    printf '%s' "Stream URLs" ;;
	config)         printf '%s' "Config file" ;;
	# System
	network)        printf '%s' "Network" ;;
	time)           printf '%s' "Time" ;;
	access)         printf '%s' "Access" ;;
	update)         printf '%s' "Update" ;;
	backup)         printf '%s' "Backup &amp; Restore" ;;
	logs)           printf '%s' "Logs" ;;
	console)        printf '%s' "Console" ;;
	files)          printf '%s' "File Manager" ;;
	sdcard)         printf '%s' "SD Card" ;;
	# Services
	openwall)       printf '%s' "OpenWall" ;;
	telegram)       printf '%s' "Telegram" ;;
	ntfy)           printf '%s' "Ntfy" ;;
	vtun)           printf '%s' "VTun" ;;
	wireguard)      printf '%s' "WireGuard" ;;
	proxy)          printf '%s' "Proxy" ;;
	# Reached from a page rather than from the bar
	editor)         printf '%s' "Text Editor" ;;
	factory-reset)  printf '%s' "Factory reset" ;;
	# FPV builds only; not in any nav, reachable by URL
	wfb)            printf '%s' "WFB Settings" ;;
	# A page with no row prints its own filename. That is visibly wrong on
	# screen rather than a blank heading, and the lint rule is what stops one
	# reaching a camera in the first place.
	*)              printf '%s' "$1" ;;
	esac
}

# page_menu <pagename>   which bar menu holds it, or nothing for a top-level page
#
# Only the browser tab uses this, so a window of camera tabs reads
# "System - Network - OpenIPC" rather than four tabs all called Network. The
# page's own heading stays the bare word: the bar is on screen right above it
# and does not need repeating.
page_menu() {
	case "$1" in
	camera|stream-urls|config)
		printf '%s' "Camera" ;;
	network|time|access|update|backup|logs|console|files|sdcard)
		printf '%s' "System" ;;
	openwall|telegram|ntfy|vtun|wireguard|proxy)
		printf '%s' "Services" ;;
	esac
}
%>

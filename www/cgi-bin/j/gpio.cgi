#!/bin/sh
# Tombstone. The pads moved into majestic: GET /api/v1/gpio to enumerate,
# POST it with ?pair= or ?park= to move one.
#
# This file is four lines rather than none, and that is the whole point. The
# rootfs is a read-only squashfs with a writable overlay on top, and
# sbin/updatewebui prunes the overlay copy of any file a release stops
# shipping — which UNCOVERS the firmware's own older copy underneath. Deleting
# this one would therefore not remove it: it would restore the previous
# version, which reads majestic's configuration out of a file that omits every
# defaulted key, drives pads with no coordination against the daemon's own
# day/night transitions, and takes all of that on a GET. An overlay file has to
# stay here to keep that buried.
#
# 410 rather than a redirect: there is no equivalent URL to send a caller to.
# The enumeration is a GET and the actuations are POSTs now, so nothing that
# followed a redirect here would arrive with the right method anyway.
#
# REMOVE AFTER 2027-06.
printf 'HTTP/1.1 410 Gone\nContent-Type: application/json\nCache-Control: no-store\n\n'
printf '{"error":"the pads moved into majestic; use /api/v1/gpio"}\n'

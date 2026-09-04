#!/bin/sh
# Tombstone for the pre-rename name. REMOVE AFTER 2027-06; see moved_to in
# p/common.cgi for why these exist at all.
#
# telegram.cgi publishes .../cgi-bin/ext-telegram.cgi?send=image as a webhook
# for other systems to call, and people have it configured in them.
#
# exec rather than a redirect, because this URL is called by machines: a curl
# without -L takes the 302 as the answer and never sends anything. exec keeps
# the method, the body and the query string, so the caller cannot tell.
exec /var/www/cgi-bin/telegram.cgi

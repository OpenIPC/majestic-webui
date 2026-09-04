#!/bin/sh
# Tombstone for the pre-rename name. REMOVE AFTER 2027-06; see moved_to in
# p/common.cgi for why these exist at all.
#
# backup.cgi publishes a wget line ending
# .../cgi-bin/ext-backuper.cgi?backup=create for remote backups, and people
# have it in scripts.
#
# exec rather than a redirect, because this URL is called by machines: a curl
# without -L takes the 302 as the answer and never sends anything. exec keeps
# the method, the body and the query string, so the caller cannot tell.
exec /var/www/cgi-bin/backup-create.cgi

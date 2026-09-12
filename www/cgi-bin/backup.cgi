#!/usr/bin/haserl
<%in p/common.cgi %>
<%in p/header.cgi %>
<% config_file=/etc/webui/backup.conf

config_create() { # config_create
	echo "
#=== OpenIPC webui backuper config,
#=== <- this is comment line
#=== FILES you need to backup, one per line, full path, line begins from #
#/etc/webui/
#/etc/majestic.yaml
#/etc/fstab
#/usr/sbin/motion.sh

#=== COMMANDS, one per liine, to be executed AFTER restoring from backup
cli -s .audio.enabled true
cli -s .audio.speakerPin 64
cli -s .audio.codec opus
cli -s .audio.srate 48000
cli -s .audio.volume 40
cli -s .audio.outputEnabled true
cli -s .audio.outputVolume 80
" > $config_file # config finish
}
if [ ! -f $config_file ]; then # check & create config_file
	config_create
fi

if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		save)
			editor_text=$(echo "$POST_editor_text" | sed s/\\r//g)
			echo "$editor_text" > "$config_file"
			redirect_to "$SCRIPT_NAME"
			;;
	esac

	redirect_to "$HTTP_REFERER"
fi
%>

<div class="row g-4">
	<div class="col-12 col-lg-6">
		<div class="card mb-4"><div class="card-body">
			<% card_head "Backup &amp; Restore" %>
			<p class="small text-secondary">Download a <code>.tgz</code> of the files listed in the backuper configuration.</p>
			<a class="btn btn-primary" href="backup-create.cgi?backup=create">Create backup</a>

			<hr class="my-3">
			<p class="small text-secondary mb-1">Or create one remotely (click to copy, then replace <code>PASSWORD</code> with your WebUI password):</p>
			<pre class="cp2cb small mb-0">wget --content-disposition <span class="ep-http">http</span>://root:PASSWORD@<span class="ep-host"><% esc "$network_address" %></span>/cgi-bin/backup-create.cgi?backup=create</pre>

			<details class="mt-3">
				<summary class="small">Restore from a backup (manual)</summary>
				<ol class="small text-secondary mt-2 mb-1">
					<li>Place <code>_backup_.tgz</code> in <code>/tmp</code> on the camera.</li>
					<li>Run: <code>cd / &amp;&amp; zcat /tmp/_backup_.tgz | tar x --overwrite &amp;&amp; sh /etc/webui/backup.conf</code></li>
				</ol>
				<p class="x-small text-danger mb-0">This overwrites your current settings.</p>
			</details>
		</div></div>

		<%
			# One control, and it is the one that cannot be undone.
			#
			# "Restart camera" stood here too until the System menu grew it (issue
			# #444), which is where somebody looks for a reboot; here it was a
			# second copy on a page nobody opens to restart a camera. Its going
			# leaves this card with a single purpose, and that is worth keeping:
			# the two once sat in one flex row a gap apart asking the identical
			# "Are you sure?", so the only thing between a reboot and a factory
			# wipe was reading the button (issue #160). A rule and a second
			# heading were what separated them afterwards, and neither is needed
			# by a control that is alone behind its own. Do not put a second one
			# in here -- a wipe should be arrived at, never landed on.
		%>
		<div class="card"><div class="card-body">
			<% card_head "Danger zone" %>
			<div>
				<a class="btn btn-danger" href="factory-reset.cgi"
					data-confirm="Reset this camera to factory state?&#10;&#10;Every configuration change is erased: network and Wi-Fi, video and image settings, timezone, passwords, and every extension you have configured.&#10;&#10;You will need to set the camera up again from scratch, and reach it on whatever address DHCP gives it. This cannot be undone.">Reset firmware</a>
				<p class="x-small text-secondary mt-1 mb-0">Revert to factory state by wiping the overlay. <span class="text-danger">Destroys all changes, and cannot be undone.</span></p>
			</div>
		</div></div>
	</div>

	<div class="col-12 col-lg-6">
		<div class="card"><div class="card-body">
			<% card_head "Backuper configuration" %>
			<p class="small text-secondary mb-2">Lines starting <code>#/</code> are files to back up; <code>cli -s …</code> lines run after a restore.</p>
			<form action="<%= $SCRIPT_NAME %>" method="post">
				<% field_hidden "action" "save" %>
				<textarea name="editor_text" class="form-control font-monospace small" style="height:20rem;white-space:pre;overflow-wrap:normal" spellcheck="false"><% sed 's/&/\&amp;/g;s/</\&lt;/g;s/>/\&gt;/g' "$config_file" %></textarea>
				<% button_submit "Save configuration" %>
			</form>
		</div></div>
	</div>
</div>

<%in p/footer.cgi %>

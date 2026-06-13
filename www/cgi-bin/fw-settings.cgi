#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Firmware & Backup" %>
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
			<h3>Backup &amp; Restore</h3>
			<p class="small text-secondary">Download a <code>.tgz</code> of the files listed in the backuper configuration.</p>
			<a class="btn btn-primary" href="ext-backuper.cgi?backup=create">Create backup</a>

			<hr class="my-3">
			<p class="small text-secondary mb-1">Or create one remotely (click to copy):</p>
			<pre class="cp2cb small mb-0">wget --content-disposition http://root:12345@<%= $network_address %>/cgi-bin/ext-backuper.cgi?backup=create</pre>

			<details class="mt-3">
				<summary class="small">Restore from a backup (manual)</summary>
				<ol class="small text-secondary mt-2 mb-1">
					<li>Place <code>_backup_.tgz</code> in <code>/tmp</code> on the camera.</li>
					<li>Run: <code>cd / &amp;&amp; zcat /tmp/_backup_.tgz | tar x --overwrite &amp;&amp; sh /etc/webui/backup.conf</code></li>
				</ol>
				<p class="x-small text-danger mb-0">This overwrites your current settings.</p>
			</details>
		</div></div>

		<div class="card"><div class="card-body">
			<h3>Maintenance</h3>
			<div class="d-flex flex-wrap gap-4">
				<div>
					<a class="btn btn-outline-secondary confirm" href="fw-restart.cgi">Restart camera</a>
					<p class="x-small text-secondary mt-1 mb-0">Reboot to apply settings and clear temporary files.</p>
				</div>
				<div>
					<a class="btn btn-danger" href="fw-reset.cgi">Reset firmware</a>
					<p class="x-small text-secondary mt-1 mb-0">Revert to factory state by wiping the overlay. <span class="text-danger">Destroys all changes.</span></p>
				</div>
			</div>
		</div></div>
	</div>

	<div class="col-12 col-lg-6">
		<div class="card h-100"><div class="card-body">
			<h3>Backuper configuration</h3>
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

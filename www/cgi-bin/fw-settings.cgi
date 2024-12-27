#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Firmware Settings & Backuper" %>
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

<div class="alert alert-info">
	<p>Create backup remotely, e.g. from script:</p>
	<dt class="cp2cb"> wget --content-disposition http://root:12345@<%= $network_address %>/cgi-bin/ext-backuper.cgi?backup=create </dt>
</div>

<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
	<div class="col">
		<div class="alert alert-danger">
			<h4>Restart Camera</h4>
			<p>Reboot camera to apply new settings and reset temporary files.</p>
			<a class="btn btn-danger" href="fw-restart.cgi">Restart Camera</a>
		</div>
		<div class="alert alert-danger">
			<h4>Reset Firmware</h4>
			<p>Revert firmware to original state by resetting the overlay partition.</p>
			<a class="btn btn-danger" href="fw-reset.cgi">Reset Firmware</a>
		</div>
	</div>

	<div class="col">
		<div class="alert alert-success">
			<h4>Backup files</h4>
			<p>Create backup of files, listed in backuper configuration.</p>
			<a class="btn btn-primary" href="ext-backuper.cgi?backup=create">Create Backup</a>
		</div>
		<div class="alert alert-info">
			<h4>Restore from a backup</h4>
			<p>Currently, only manual recovery is available.</p>
			<p>To restore files from a previously created backup to the camera, follow these steps:</p>
			<p>1. place the _backup_.tgz file in /tmp on the camera</p>
			<p>2. run:<br>
			<b>cd / && zcat /tmp/_backup_.tgz | tar x --overwrite && sh /etc/webui/backup.conf</b></p>
			<p class="text-danger">This action removes all current settings!</p>
			<a class="btn btn-danger disabled" href="ext-backuper.cgi?backup=restore">Restore from Backup</a>
		</div>
	</div>

	<div class="col">
		<h4>Backuper configuration</h4>
		<% [ -e "$config_file" ] && ex "cat $config_file" %>
		<p><a class="btn btn-secondary" href="fw-editor.cgi?f=<%= $config_file %>">Edit Configuration</a></p>
		<form action="<%= $SCRIPT_NAME %>" method="POST">
	</div>
</div>

<%in p/footer.cgi %>

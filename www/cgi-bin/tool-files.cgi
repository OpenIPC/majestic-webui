#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="File Manager" %>
<%
	# Process actions first
	action=${POST_action:-""}
	
	# For debugging
	if [ -n "$action" ]; then
		echo "<!-- Debug: Action = $action -->" >/dev/null
	fi
	
	if [ "$action" = "delete" ] && [ -n "$POST_path" ]; then
		# Improved delete with error handling and support for directories
		target_path="$POST_path"
		echo "<!-- Debug: Delete path = $target_path -->" >/dev/null
		
		if [ -d "$target_path" ]; then
			# For directories, use rmdir
			rmdir "$target_path" 2>/dev/null || rm -rf "$target_path" 2>/dev/null
		else
			# For files, use rm
			rm -f "$target_path" 2>/dev/null
		fi
		
		# Check if delete was successful
		if [ ! -e "$target_path" ]; then
			delete_status="success"
		else
			delete_status="failed"
		fi
	elif [ "$action" = "mkdir" ] && [ -n "$POST_dir" ] && [ -n "$POST_name" ]; then
		mkdir -p "$POST_dir/$POST_name" 2>/dev/null
	elif [ "$action" = "newfile" ] && [ -n "$POST_dir" ] && [ -n "$POST_name" ]; then
		touch "$POST_dir/$POST_name" 2>/dev/null
	elif [ "$action" = "rename" ] && [ -n "$POST_path" ] && [ -n "$POST_newname" ]; then
		dir=$(dirname "$POST_path")
		mv "$POST_path" "$dir/$POST_newname" 2>/dev/null
	elif [ "$action" = "upload" ] && [ -n "$POST_dir" ]; then
		# Basic file upload handling
		while [ -n "$HASERL_uploadfile_0" ]; do
			mv "$HASERL_uploadfile_0_path" "$POST_dir/$HASERL_uploadfile_0_name" 2>/dev/null
			break # Only handle one file for simplicity
		done
	fi

	# Navigation
	[ -n "$GET_cd" ] && dir=${GET_cd}
	dir=$(cd ${dir:-/}; pwd | sed s#^//#/#)
	back=$(cd ${dir}/..; pwd | sed s#^//#/#)

	# Function to check if file type is editable
	is_editable() {
		local file="$1"
		local ext="${file##*.}"
		# Define editable file extensions
		case "$ext" in
			yaml|yml|conf|txt|sh|cgi|html|css|js|log|md|xml|json)
				return 0 # True - file is editable
				;;
			*)
				return 1 # False - file is not editable
				;;
		esac
	}

	# Function to format file size
	format_size() {
		local size=$1
		if [ $size -lt 1024 ]; then
			echo "${size}B"
		elif [ $size -lt 1048576 ]; then
			echo "$(( size / 1024 ))K"
		else
			echo "$(( size / 1048576 ))M"
		fi
	}
%>

<%in p/header.cgi %>

<% 
	# Display status messages if there are any
	if [ "$delete_status" = "success" ]; then 
		echo "<div class=\"alert alert-success alert-dismissible fade show\" role=\"alert\">"
		echo "  File or directory deleted successfully."
		echo "  <button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>"
		echo "</div>"
	elif [ "$delete_status" = "failed" ]; then
		echo "<div class=\"alert alert-danger alert-dismissible fade show\" role=\"alert\">"
		echo "  Failed to delete file or directory. Check permissions."
		echo "  <button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>"
		echo "</div>"
	fi
%>

<h4>File Manager</h4>

<div class="row mb-3">
	<div class="col-auto">
		<a href="?cd=<%= $back %>" class="btn btn-sm btn-secondary">Up</a>
	</div>
	<div class="col-auto ms-auto">
		<div class="btn-group">
			<button type="button" class="btn btn-sm btn-primary" data-bs-toggle="modal" data-bs-target="#newFileModal">New File</button>
			<button type="button" class="btn btn-sm btn-primary" data-bs-toggle="modal" data-bs-target="#newDirModal">New Folder</button>
			<button type="button" class="btn btn-sm btn-primary" data-bs-toggle="modal" data-bs-target="#uploadModal">Upload</button>
		</div>
	</div>
</div>

<h4><%= $dir %></h4>

<!-- Header row -->
<div class="row mb-3 fw-bold">
	<div class="col-10 col-lg-4">Name</div>
	<div class="col-2 col-lg-2 text-end">Size</div>
	<div class="col-6 col-lg-2 text-center">Permissions</div>
	<div class="col-6 col-lg-2 text-end">Last Modified</div>
	<div class="col-12 col-lg-2 text-center">Actions</div>
</div>

<%
	filename=$(ls --group-directories-first $dir)
	for line in $filename; do
		path=$(echo "${dir}/${line}" | sed s!^//!/!)
		[ "$path" = "/proc" ] || [ "$path" = "/sys" ] && continue

		fileinfo=$(stat -c "%s.%a.%Y" $path 2>/dev/null)
		[ -z "$fileinfo" ] && continue
		
		filesize=$(echo $fileinfo | cut -d. -f1)
		formatted_size=$(format_size $filesize)
		permission=$(echo $fileinfo | cut -d. -f2)
		timestamp=$(echo $fileinfo | cut -d. -f3)
		date_str=$(date -d @$timestamp "+%Y-%m-%d %H:%M")

		echo "<div class=\"row mb-3\">"
		echo "<div class=\"col-10 col-lg-4\">"
		if [ -d "${path}" ]; then
			echo "<a href=\"?cd=${path}\" class=\"fw-bold\">${line}</a>"
		else
			echo "<a href=\"${path}\" class=\"fst-italic\">${line}</a>"
		fi
		echo "</div>"
		
		echo "<div class=\"col-2 col-lg-2 font-monospace text-end\">${formatted_size}</div>"
		echo "<div class=\"col-6 col-lg-2 font-monospace text-center\">${permission}</div>"
		echo "<div class=\"col-6 col-lg-2 font-monospace text-end\">${date_str}</div>"
		
		# Actions column with edit button and dropdown menu
		echo "<div class=\"col-12 col-lg-2 text-center\">"
		echo "<div class=\"btn-group\">"
		
		# Edit button for editable files
		if [ ! -d "${path}" ] && is_editable "$line"; then
			echo "<a href=\"fw-editor.cgi?f=${path}\" class=\"btn btn-sm btn-primary\">Edit</a>"
		fi
		
		# Actions dropdown
		echo "<button type=\"button\" class=\"btn btn-sm btn-secondary dropdown-toggle\" data-bs-toggle=\"dropdown\">Actions</button>"
		echo "<ul class=\"dropdown-menu dropdown-menu-end\">"
		echo "<li><a class=\"dropdown-item\" href=\"#\" data-bs-toggle=\"modal\" data-bs-target=\"#renameModal\" "
		echo "data-path=\"${path}\" data-name=\"${line}\">Rename</a></li>"
		
		# Direct delete form for more reliable operation
		echo "<li>"
		echo "<form method=\"post\" class=\"d-inline\" onsubmit=\"return confirm('Are you sure you want to delete ${line}?')\">"
		echo "<input type=\"hidden\" name=\"action\" value=\"delete\">"
		echo "<input type=\"hidden\" name=\"path\" value=\"${path}\">"
		echo "<button type=\"submit\" class=\"dropdown-item text-danger\">Delete</button>"
		echo "</form>"
		echo "</li>"
		
		echo "</ul>"
		echo "</div>"
		echo "</div>"
		
		echo "</div>"
	done
%>

<!-- Modals for file operations -->
<!-- New File Modal -->
<div class="modal fade" id="newFileModal" tabindex="-1">
	<div class="modal-dialog">
		<div class="modal-content">
			<div class="modal-header">
				<h5 class="modal-title">Create New File</h5>
				<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
			</div>
			<form method="post">
				<div class="modal-body">
					<input type="hidden" name="action" value="newfile">
					<input type="hidden" name="dir" value="<%= $dir %>">
					<div class="mb-3">
						<label class="form-label">File Name</label>
						<input type="text" class="form-control" name="name" required>
					</div>
				</div>
				<div class="modal-footer">
					<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
					<button type="submit" class="btn btn-primary">Create</button>
				</div>
			</form>
		</div>
	</div>
</div>

<!-- New Directory Modal -->
<div class="modal fade" id="newDirModal" tabindex="-1">
	<div class="modal-dialog">
		<div class="modal-content">
			<div class="modal-header">
				<h5 class="modal-title">Create New Folder</h5>
				<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
			</div>
			<form method="post">
				<div class="modal-body">
					<input type="hidden" name="action" value="mkdir">
					<input type="hidden" name="dir" value="<%= $dir %>">
					<div class="mb-3">
						<label class="form-label">Folder Name</label>
						<input type="text" class="form-control" name="name" required>
					</div>
				</div>
				<div class="modal-footer">
					<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
					<button type="submit" class="btn btn-primary">Create</button>
				</div>
			</form>
		</div>
	</div>
</div>

<!-- Rename Modal -->
<div class="modal fade" id="renameModal" tabindex="-1">
	<div class="modal-dialog">
		<div class="modal-content">
			<div class="modal-header">
				<h5 class="modal-title">Rename</h5>
				<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
			</div>
			<form method="post">
				<div class="modal-body">
					<input type="hidden" name="action" value="rename">
					<input type="hidden" name="path" id="renamePath">
					<div class="mb-3">
						<label class="form-label">New Name</label>
						<input type="text" class="form-control" name="newname" id="renameInput" required>
					</div>
				</div>
				<div class="modal-footer">
					<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
					<button type="submit" class="btn btn-primary">Rename</button>
				</div>
			</form>
		</div>
	</div>
</div>

<!-- Upload Modal -->
<div class="modal fade" id="uploadModal" tabindex="-1">
	<div class="modal-dialog">
		<div class="modal-content">
			<div class="modal-header">
				<h5 class="modal-title">Upload File</h5>
				<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
			</div>
			<form method="post" enctype="multipart/form-data">
				<div class="modal-body">
					<input type="hidden" name="action" value="upload">
					<input type="hidden" name="dir" value="<%= $dir %>">
					<div class="mb-3">
						<label class="form-label">Select File</label>
						<input type="file" class="form-control" name="file">
					</div>
				</div>
				<div class="modal-footer">
					<button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
					<button type="submit" class="btn btn-primary">Upload</button>
				</div>
			</form>
		</div>
	</div>
</div>

<script>
document.addEventListener('DOMContentLoaded', function() {
	// Set up rename modal
	document.getElementById('renameModal').addEventListener('show.bs.modal', function (event) {
		var button = event.relatedTarget;
		var path = button.getAttribute('data-path');
		var name = button.getAttribute('data-name');
		document.getElementById('renamePath').value = path;
		document.getElementById('renameInput').value = name;
	});
});
</script>

<%in p/footer.cgi %>
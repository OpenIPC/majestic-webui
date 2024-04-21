#!/usr/bin/haserl
<%in p/common.cgi %>
<%
page_title="Time Settings"
tz_data=$(cat /etc/TZ)
tz_name=$(cat /etc/timezone)

if [ "$REQUEST_METHOD" = "POST" ]; then
	case "$POST_action" in
		update)
			[ -z "$POST_tz_name" ] && redirect_to "$SCRIPT_NAME" "warning" "Empty timezone name. Skipping."
			[ -z "$POST_tz_data" ] && redirect_to "$SCRIPT_NAME" "warning" "Empty timezone value. Skipping."
			[ "$tz_data" != "$POST_tz_data" ] && echo "${POST_tz_data}" > /etc/TZ
			[ "$tz_name" != "$POST_tz_name" ] && echo "${POST_tz_name}" > /etc/timezone

			rm -f /etc/ntp.conf
			for i in $(seq 0 3); do
				eval ntp="\$POST_server_${i}"
				[ -n "$ntp" ] && echo "server $ntp iburst" >> /etc/ntp.conf
			done
			redirect_back "success" "Configuration updated."
			;;
	esac

	update_caminfo
	redirect_to "$SCRIPT_NAME" "success" "Timezone updated."
fi
%>

<%in p/header.cgi %>
<form action="<%= $SCRIPT_NAME %>" method="post">
	<% field_hidden "action" "update" %>
	<div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-4 mb-4">
		<div class="col">
			<h3>Time Zone</h3>
			<datalist id="tz_list"></datalist>
			<p class="string">
				<label for="tz_name" class="form-label">Zone name</label>
				<input type="text" id="tz_name" name="tz_name" value="<%= $tz_name %>" class="form-control" list="tz_list">
				<span class="hint text-secondary">Type the name of the nearest large city.</span>
			</p>
			<p class="string">
				<label for="tz_data" class="form-label">Zone string</label>
				<input type="text" id="tz_data" name="tz_data" value="<%= $tz_data %>" class="form-control" readonly>
				<span class="hint text-secondary">Control string of the timezone selected above.</span>
			</p>
			<p><a href="#" id="frombrowser">Pick up timezone from browser</a></p>
		</div>

		<div class="col">
		<h3>Synchronization</h3>
			<%
			for i in $(seq 0 3); do
				eval server_${i}=$(sed -n $((i + 1))p /etc/ntp.conf | awk '{print $2}')
				field_text "server_${i}" "Server $((i + 1))"
			done
			%>
			<p id="sync-time-wrapper"><a href="#" id="sync-time">Sync time</a></p>
		</div>

		<div class="col">
		<h3>Configuration</h3>
			<% ex "cat /etc/timezone" %>
			<% ex "cat /etc/TZ" %>
			<% ex "cat /etc/ntp.conf" %>
		</div>
	</div>
	<% button_submit %>
</form>

<script src="/a/timezone.js"></script>
<script>
	function findTimezone(tz) {
		return tz.n == $("#tz_name").value;
	}

	function updateTimezone() {
		const tz = TZ.filter(findTimezone);
		$("#tz_data").value = (tz.length == 0) ? "" : tz[0].v;
	}

	function useBrowserTimezone(event) {
		event.preventDefault();
		$("#tz_name").value = Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ');
		updateTimezone();
	}

	window.addEventListener('load', () => {
		const tzn = $("#tz_name");
		if (navigator.userAgent.includes("Android") && navigator.userAgent.includes("Firefox")) {
			const sel = document.createElement("select");
			sel.classList.add("form-select");
			sel.name = "tz_name";
			sel.id = "tz_name";
			sel.options.add(new Option());
			let opt;
			TZ.forEach(function (tz) {
				opt = new Option(tz.n);
				opt.selected = (tz.n == tzn.value);
				sel.options.add(opt);
			});
			tzn.replaceWith(sel);
		} else {
			const el = $("#tz_list");
				el.innerHTML = "";
				TZ.forEach(function (tz) {
				const o = document.createElement("option");
				o.value = tz.n;
				el.appendChild(o);
			});
		}
		tzn.addEventListener("focus", ev => ev.target.select());
		tzn.addEventListener("selectionchange", updateTimezone);
		tzn.addEventListener("change", updateTimezone);
		$("#frombrowser").addEventListener("click", useBrowserTimezone);
	});

	$('#sync-time').addEventListener('click', event => {
		event.preventDefault();
		fetch('/cgi-bin/j/time.cgi')
			.then((response) => response.json())
			.then((json) => {
				p = document.createElement('p');
				p.classList.add('alert', 'alert-' + json.result);
				p.textContent = json.message;
				$('#sync-time-wrapper').replaceWith(p);
			})
	});
</script>

<%in p/footer.cgi %>

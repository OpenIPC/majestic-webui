#!/usr/bin/haserl
<%in p/common.cgi %>

<% hide_signature=1 %>
<% hide_title=1 %>
<%in p/header.cgi %>

<% overlay_use=$(df -h /overlay 2>/dev/null | awk 'NR==2{print $3" of "$2" used"}') %>
<% ovd=/overlay/root; [ -d "$ovd" ] || ovd=/overlay/upper; [ -d "$ovd" ] || ovd=/overlay %>
<% ov_df=$(df -k /overlay 2>/dev/null | awk 'NR==2{printf "%d %d %d",$2,$3,$4}') %>
<% ov_total=$(echo $ov_df | cut -d' ' -f1) %>
<% ov_used=$(echo $ov_df | cut -d' ' -f2) %>
<% ov_avail=$(echo $ov_df | cut -d' ' -f3) %>
<% ov_cats=$(du -sk "$ovd"/* 2>/dev/null | sort -rn | awk '{n=$2; sub(/.*\//,"",n); printf "%s{\"name\":\"%s\",\"kb\":%d}",(NR>1?",":""),n,$1}') %>
<% sd_rows=$(df -h 2>/dev/null | awk '/mmcblk|\/mnt\/|\/media\/|\/sdcard/{print $6"|"$3" / "$2"|"$5}') %>
<%# One row per interface that is up and addressed — common.cgi's network_*
    variables describe only the first default route's device, which hides the
    second interface on a camera running eth0 and wlan0 at once. %>
<% net_defdev=$(ip route 2>/dev/null | awk '/^default/ {print $5; exit}') %>
<% net_rows=$(for i in /sys/class/net/*; do
	n=${i##*/}
	[ "$n" = "lo" ] && continue
	[ "$(cat $i/operstate 2>/dev/null)" = "down" ] && continue
	a=$(ip addr show dev $n 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)
	[ -z "$a" ] && continue
	echo "$n|$a|$(cat $i/address 2>/dev/null)"
done) %>
<% net_gw=$(ip route 2>/dev/null | awk '/^default/ && !seen[$3]++ {printf "%s%s", (n++ ? ", " : ""), $3}') %>

<!-- No page <h2>: the navbar's active item is the title. Alerts come first,
     in the same slot header.cgi uses for its own banners, and render nothing
     while the camera is healthy — space is only spent on signal. -->
<div id="st-alerts" class="mt-3" hidden aria-live="polite">
	<div class="st-alert" id="st-alert-stale" hidden>
		<span class="st-alert-ico" aria-hidden="true">&#9888;</span>
		<span class="small">Camera is not responding — retrying&hellip;</span>
	</div>
	<!-- There is no "Exposure at maximum" banner. isp_exposureismax is a true
	     reading and a nightly one: auto-exposure runs out of shutter and gain
	     every night on every camera, so it fired at dusk and stood until dawn,
	     saying only that it had got dark. It was HiSilicon's alone as well —
	     Ingenic and SigmaStar publish no such gauge — so it could never have
	     meant the same thing on two cameras, which is the defect the old
	     "Encoder stalled" banner had. The reading is kept where it is an
	     observation rather than an accusation: beside the scene-luminance
	     chart it is about (#273). -->
	<!-- The wording is written by dashboard.js from the finding it is reporting:
	     one banner covers a missing pin, a light monitor with nothing to watch,
	     thresholds with no hysteresis and a day/night disagreement, and each
	     needs its own sentence. -->
	<!-- "No filter here" is offered only for the missing-pin finding, and
	     dashboard.js unhides it: nothing the camera can measure separates a
	     filter nobody wired from a camera that has none, so the owner is the
	     only one who can say. Every other finding is about a filter that is
	     configured, and none of them can be waved away. -->
	<div class="st-alert" id="st-alert-ircut" hidden>
		<span class="st-alert-ico" aria-hidden="true">&#9888;</span>
		<span class="small"><b id="st-alert-ircut-t"></b> &mdash; <span id="st-alert-ircut-d"></span></span>
		<a class="small ms-auto" href="camera.cgi?tab=nightMode">Open Day / Night &rarr;</a>
		<!-- A bare ×, and it has been three things. "No filter here" read as
		     something the page was ASSERTING rather than a button; "Dismiss"
		     fixed that but put a second link-styled phrase beside "Open Day /
		     Night", and two of those in a row read as a pair of choices rather
		     than an action and a way out (#273). The × is the convention every
		     dismissible notice already uses — including this UI's own modal
		     headers — so it needs no word to be understood, and it stops
		     competing with the link for the eye.
		     The name it loses lives in aria-label and title, and the claim it
		     never carried is still made in full by the confirm dialog: this
		     records a fact on the camera, for every browser, permanently. -->
		<button type="button" class="btn-close" id="st-alert-ircut-no" aria-label="Dismiss: this camera has no IR-cut filter" title="Dismiss: this camera has no IR-cut filter" hidden></button>
	</div>
	<!-- Nothing to see, and the wording is written by dashboard.js from the finding
	     (video-check.js), because one banner covers three of them: a camera
	     reading no light at all, an encoder that has stopped, and a camera with
	     no channel enabled. This replaced a fixed "Encoder stalled" banner that
	     could only ever fire on SigmaStar, and that said nothing about the
	     fault a newly flashed camera actually has — the wrong sensor driver,
	     which streams perfectly and streams black. -->
	<div class="st-alert" id="st-alert-novideo" hidden>
		<span class="st-alert-ico" aria-hidden="true">&#9888;</span>
		<span class="small"><b id="st-alert-novideo-t"></b> &mdash; <span id="st-alert-novideo-d"></span></span>
		<a class="small ms-auto" id="st-alert-novideo-a" href="camera.cgi?tab=isp"></a>
		<!-- Only on a hardware finding. What this page can say is worked out
		     from two gauges; the log is where majestic says what happened when
		     it brought the sensor up, and it is what an owner can screenshot
		     for whoever sold them the camera. -->
		<a class="small ms-3" id="st-alert-novideo-h" href="logs.cgi" hidden></a>
	</div>
	<!-- Why you are here, when the Live page sent you and the fault has since
	     cleared. Being moved to another page for no visible reason is worse
	     than the fault it was moving you away from. -->
	<div class="st-alert" id="st-alert-wasnovideo" hidden>
		<span class="st-alert-ico" aria-hidden="true">&#8505;</span>
		<!-- Two states, because this page needs its own ten seconds to reach a
		     verdict and during them it knows nothing. Saying "it looks fine
		     now" on arrival would be a reassurance issued before anything had
		     been measured — and on the camera this feature exists for, it would
		     be contradicted by the banner above a few seconds later. So the
		     sentence starts as the bare fact of the hand-off and only earns its
		     second half (status.js) once the check has run and found nothing. -->
		<span class="small">Live video was not available a moment ago, so you were brought here.<span id="st-alert-wasnovideo-ok"></span></span>
		<a class="small ms-auto" href="live.cgi">Open Live &rarr;</a>
	</div>
</div>

<!-- KPI strip: tiles mount per what this camera reports; the grid closes up
     around an absent one instead of holding an empty slot. -->
<div class="st-kpis mt-3" aria-live="polite">
	<div class="st-panel st-tile">
		<div class="mj-cap">CPU</div>
		<div class="st-val"><span id="st-cpu">&ndash;</span><span class="st-unit"> %</span></div>
		<div class="x-small text-secondary">load <span id="st-load">&ndash;</span>
			<a href="https://github.com/OpenIPC/wiki/blob/master/en/trouble-load-average.md"
			   class="text-secondary text-decoration-none"
			   aria-label="Why is the load average high?"
			   title="1-minute load average — not a CPU-usage figure. Linux counts tasks in uninterruptible sleep as well as runnable ones, and vendor SDK driver threads stay in that state permanently, so on SigmaStar SoCs this reads 12-13 even on an idle camera. Judge the CPU by the percentage above. Click for details.">&#9432;</a>
		</div>
		<div id="spark-cpu" class="spark st-tile-spark"></div>
	</div>
	<div class="st-panel st-tile">
		<div class="mj-cap">Memory</div>
		<div class="st-val"><span id="st-ram">&ndash;</span><span class="st-unit"> %</span></div>
		<div class="x-small text-secondary"><span id="st-ram-mb">&ndash;</span></div>
		<div id="spark-ram" class="spark st-tile-spark"></div>
	</div>
	<div class="st-panel st-tile">
		<div class="mj-cap">Temperature</div>
		<div class="st-val"><span id="st-temp">&ndash;</span><span class="st-unit" id="st-temp-u"> &deg;C</span></div>
		<div class="x-small text-secondary" id="st-temp-note">SoC</div>
		<div id="spark-temp" class="spark st-tile-spark"></div>
	</div>
	<div class="st-panel st-tile" id="st-enc-tile">
		<div class="mj-cap">Encoder out</div>
		<div class="st-val"><span id="st-enc">&ndash;</span><span class="st-unit"> Mbit/s</span></div>
		<div class="x-small text-secondary" id="st-enc-sub">main stream</div>
		<div id="spark-enc" class="spark st-tile-spark"></div>
	</div>
	<div class="st-panel st-tile" id="st-wifi-tile" hidden>
		<div class="mj-cap">Wi-Fi signal</div>
		<div class="st-val"><span id="st-wifi-dbm">&ndash;</span><span class="st-unit"> dBm</span></div>
		<div class="x-small text-secondary" id="st-wifi-grade"></div>
		<div id="spark-wifi" class="spark st-tile-spark"></div>
	</div>
	<div class="st-panel st-tile">
		<div class="mj-cap">Uptime</div>
		<div class="st-val-sm" id="st-uptime">&ndash;</div>
		<div class="x-small text-secondary">Majestic <span id="st-uptime-mj">&ndash;</span></div>
		<div class="x-small text-secondary mt-2"><span id="st-hls">0</span> HLS clients</div>
	</div>
</div>

<div class="st-grid mt-3">
	<div class="st-charts">

		<!-- The camera itself, first: a polled snapshot, not a stream — costs
		     no majestic session slot. Clicking goes to the Live page. -->
		<div class="st-hero-row">
			<a class="st-prev" id="st-prev" href="live.cgi" aria-label="Open Live view">
				<%# A src is required for valid HTML5; a blank inline SVG stands in
				    until dashboard.js swaps in the first successful /image.jpg. %>
				<img id="st-prev-img" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'/%3E" alt="" hidden>
				<span class="st-prev-off small" id="st-prev-off">loading&hellip;</span>
				<span class="st-prev-play" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span>
				<span class="st-prev-chip" id="st-prev-chip" hidden></span>
				<span class="st-prev-bar"><span id="st-prev-note">snapshot</span><span class="st-prev-go">Open Live &rarr;</span></span>
			</a>
			<div class="st-panel st-chartbox" id="st-enc-panel">
				<div class="st-chart-head">
					<span class="mj-cap">Encoder output &mdash; main stream</span>
					<span class="st-now" id="st-enc-now"></span>
				</div>
				<div class="st-chart" id="ch-enc"></div>
			</div>
		</div>

		<div class="st-chart-row">
			<div class="st-panel st-chartbox">
				<div class="st-chart-head">
					<span class="mj-cap">Network (Mbit/s)</span>
					<span class="x-small text-secondary st-legend">
						<span><i class="st-dot st-dot-c1"></i>up</span>
						<span><i class="st-dot st-dot-c2"></i>down</span>
					</span>
				</div>
				<div class="st-chart" id="ch-net"></div>
			</div>
			<div class="st-panel st-chartbox" id="st-wifi-panel" hidden>
				<div class="st-chart-head">
					<span class="mj-cap">Wi-Fi signal</span>
					<span class="st-now" id="st-rssi-now"></span>
				</div>
				<div class="st-chart" id="ch-rssi"></div>
				<div class="x-small text-secondary" id="st-wifi-sub"></div>
			</div>
		</div>

		<%# The tile above says how full memory is; this says whether it is
		    filling, and with what. An hour wide, because a leak is not a fact
		    about this minute -- see issue #322. Hidden until the camera turns
		    out to report the parts, and hidden on the ROW rather than on the
		    panel: this is the only row with a single occupant, and a row whose
		    one child is hidden is still a flex box paying its parent's gap. %>
		<div class="st-chart-row" id="st-mem-row" hidden>
			<div class="st-panel st-chartbox" id="st-mem-panel">
				<div class="st-chart-head">
					<span class="mj-cap">Memory &mdash; what is holding it</span>
					<span class="x-small text-secondary st-legend">
						<span id="st-mem-lg-prog"><i class="st-dot st-dot-c1"></i>Programs</span>
						<span id="st-mem-lg-krn"><i class="st-dot st-dot-c3"></i>Kernel</span>
						<span id="st-mem-lg-disk"><i class="st-dot st-dot-c2"></i>RAM disk</span>
					</span>
				</div>
				<div class="st-chart" id="ch-mem"></div>
				<div class="x-small text-secondary" id="st-mem-note"></div>
			</div>
		</div>

		<div class="st-chart-row">
			<div class="st-panel st-chartbox" id="st-luma-panel" hidden>
				<div class="st-chart-head">
					<span class="mj-cap">Scene luminance</span>
					<span class="st-now" id="st-luma-now"></span>
				</div>
				<div class="st-chart" id="ch-luma"></div>
				<div class="x-small text-secondary" id="st-luma-note"></div>
			</div>
			<div class="st-panel st-chartbox">
				<div class="st-chart-head">
					<span class="mj-cap">ISP &mdash; what this SoC reports</span>
					<span class="x-small text-secondary">raw SDK units</span>
				</div>
				<dl class="small list mb-0" id="st-isp"></dl>
				<div class="small text-secondary" id="st-isp-empty">loading&hellip;</div>
				<div class="x-small text-secondary mt-2" id="st-daynight" aria-live="polite"></div>
			</div>
		</div>
	</div>

	<div class="st-rail">
		<div class="st-panel">
			<div class="mj-cap mb-2">Streams</div>
			<div id="streams" class="d-flex flex-column gap-2"><div class="text-secondary small">loading&hellip;</div></div>
		</div>

		<div class="st-panel">
			<div class="mj-cap mb-2">Device</div>
			<dl class="small list mb-0">
				<dt>SoC</dt><dd><% esc "$soc" %> <span class="text-secondary">(<% esc "$soc_family" %>)</span></dd>
				<dt>Sensor</dt><dd><% esc "$sensor" %></dd>
				<dt>Firmware</dt><dd><% esc "${fw_version}-${fw_variant}" %></dd>
				<dt>Build</dt><dd class="text-break"><% esc "$fw_build" %></dd>
				<dt>Majestic</dt><dd><% esc "$mj_version" %></dd>
				<% if [ -n "$uboot_version" ]; then %>
					<dt>U-Boot</dt><dd><% esc "$uboot_version" %></dd>
				<% fi %>
			</dl>
		</div>

		<div class="st-panel">
			<div class="mj-cap mb-2">Storage</div>
			<dl class="small list mb-2">
				<dt>Flash</dt><dd><% esc "$flash_size" %> MB <span class="text-secondary"><% esc "$flash_type" %></span></dd>
			</dl>
			<div class="d-flex justify-content-between x-small mb-1">
				<span class="fw-semibold">Overlay</span><span class="text-secondary"><% esc "${overlay_use:-n/a}" %></span>
			</div>
			<div id="overlay-bar" class="storage-bar mb-2"></div>
			<div id="overlay-legend" class="storage-legend x-small mb-3"></div>
			<script type="application/json" id="overlay-data">{"total":<%= ${ov_total:-0} %>,"used":<%= ${ov_used:-0} %>,"avail":<%= ${ov_avail:-0} %>,"cats":[<%= $ov_cats %>]}</script>
			<% if [ -n "$sd_rows" ]; then %>
				<% echo "$sd_rows" | while IFS='|' read mnt use pct; do %>
					<div class="d-flex align-items-center gap-2 x-small">
						<span class="badge text-bg-success flex-shrink-0">SD</span>
						<span class="text-secondary"><% esc "$mnt — $use ($pct)" %></span>
					</div>
				<% done %>
			<% else %>
				<div class="x-small text-secondary">No SD card detected</div>
			<% fi %>
		</div>

		<div class="st-panel">
			<div class="mj-cap mb-2">Network</div>
			<dl class="small list mb-0">
				<dt>Host</dt><dd><% esc "$network_hostname" %></dd>
				<% if [ -n "$net_rows" ]; then %>
					<% echo "$net_rows" | while IFS='|' read n a m; do %>
						<dt><% esc "$n" %><% [ "$n" = "$net_defdev" ] && echo ' <span class="text-secondary x-small">default</span>' %></dt>
						<dd><% esc "$a" %><div class="x-small text-secondary text-break"><% esc "$m" %></div></dd>
					<% done %>
				<% else %>
					<dt>Address</dt><dd><% esc "$network_address" %></dd>
					<dt>MAC</dt><dd class="text-break"><% esc "$network_macaddr" %></dd>
					<dt>Link</dt><dd><% esc "$network_interface" %></dd>
				<% fi %>
				<dt>Gateway</dt><dd><% esc "${net_gw:-$network_gateway}" %></dd>
			</dl>
		</div>
	</div>
</div>

<script src="/a/charts.js" defer></script>
<script src="/a/ircut-check.js" defer></script>
<script src="/a/video-check.js" defer></script>
<script src="/a/dashboard.js" defer></script>

<%in p/footer.cgi %>

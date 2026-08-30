#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Dashboard" %>
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
	<div class="st-alert" id="st-alert-exp" hidden>
		<span class="st-alert-ico" aria-hidden="true">&#9888;</span>
		<span class="small"><b>Exposure at maximum</b> — the scene is darker than the sensor can compensate.<span id="st-alert-exp-lum"></span></span>
		<a class="small ms-auto" href="mj-settings.cgi?tab=live">Open Live adjustments &rarr;</a>
	</div>
	<div class="st-alert" id="st-alert-stall" hidden>
		<span class="st-alert-ico" aria-hidden="true">&#9888;</span>
		<span class="small"><b>Encoder stalled</b> — the encoder has stopped producing frames while everything else looks alive.</span>
		<a class="small ms-auto" href="fw-restart.cgi">Restart camera &rarr;</a>
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
	<div class="st-panel st-tile">
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
			<a class="st-prev" id="st-prev" href="preview.cgi" aria-label="Open Live view">
				<img id="st-prev-img" alt="" hidden>
				<span class="st-prev-off small" id="st-prev-off">loading&hellip;</span>
				<span class="st-prev-play" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span>
				<span class="st-prev-chip" id="st-prev-chip" hidden></span>
				<span class="st-prev-bar"><span id="st-prev-note">snapshot</span><span class="st-prev-go">Open Live &rarr;</span></span>
			</a>
			<div class="st-panel st-chartbox">
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

		<div class="st-chart-row">
			<div class="st-panel st-chartbox" id="st-luma-panel" hidden>
				<div class="st-chart-head">
					<span class="mj-cap">Scene luminance</span>
					<span class="st-now" id="st-luma-now"></span>
				</div>
				<div class="st-chart" id="ch-luma"></div>
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
	</div>
</div>

<script src="/a/status.js" defer></script>

<%in p/footer.cgi %>

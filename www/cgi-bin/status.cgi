#!/usr/bin/haserl
<%in p/common.cgi %>

<% page_title="Device Status" %>
<%in p/header.cgi %>

<% overlay_use=$(df -h /overlay 2>/dev/null | awk 'NR==2{print $3" of "$2" used"}') %>
<% ovd=/overlay/root; [ -d "$ovd" ] || ovd=/overlay/upper; [ -d "$ovd" ] || ovd=/overlay %>
<% ov_df=$(df -k /overlay 2>/dev/null | awk 'NR==2{printf "%d %d %d",$2,$3,$4}') %>
<% ov_total=$(echo $ov_df | cut -d' ' -f1) %>
<% ov_used=$(echo $ov_df | cut -d' ' -f2) %>
<% ov_avail=$(echo $ov_df | cut -d' ' -f3) %>
<% ov_cats=$(du -sk "$ovd"/* 2>/dev/null | sort -rn | awk '{n=$2; sub(/.*\//,"",n); printf "%s{\"name\":\"%s\",\"kb\":%d}",(NR>1?",":""),n,$1}') %>
<% sd_rows=$(df -h 2>/dev/null | awk '/mmcblk|\/mnt\/|\/media\/|\/sdcard/{print $6"|"$3" / "$2"|"$5}') %>

<div class="mb-3 mt-n3">
	<span id="st-badge" class="badge rounded-pill text-bg-secondary" role="status" aria-live="polite">checking…</span>
</div>

<!-- Health strip -->
<div class="row row-cols-2 row-cols-lg-4 g-3 mb-4" aria-live="polite">
	<div class="col">
		<div class="card h-100"><div class="card-body py-2">
			<div class="x-small text-uppercase text-secondary">CPU</div>
			<div class="lh-1 my-1"><span class="fs-3 fw-semibold" id="st-cpu">–</span><span class="x-small text-secondary"> %</span></div>
			<div class="progress" style="height:4px"><div id="bar-cpu" class="progress-bar" style="width:0"></div></div>
			<div class="x-small text-secondary mt-1">load <span id="st-load">–</span></div>
			<div id="spark-cpu" class="spark mt-1"></div>
		</div></div>
	</div>
	<div class="col">
		<div class="card h-100"><div class="card-body py-2">
			<div class="x-small text-uppercase text-secondary">Memory</div>
			<div class="lh-1 my-1"><span class="fs-3 fw-semibold" id="st-ram">–</span><span class="x-small text-secondary"> %</span></div>
			<div class="progress" style="height:4px"><div id="bar-ram" class="progress-bar" style="width:0"></div></div>
			<div class="x-small text-secondary mt-1"><span id="st-ram-mb">–</span></div>
			<div id="spark-ram" class="spark mt-1"></div>
		</div></div>
	</div>
	<div class="col">
		<div class="card h-100"><div class="card-body py-2">
			<div class="x-small text-uppercase text-secondary">Temperature</div>
			<div class="lh-1 my-1"><span class="fs-3 fw-semibold" id="st-temp">–</span><span class="x-small text-secondary"> °C</span></div>
			<div class="progress" style="height:4px"><div id="bar-temp" class="progress-bar" style="width:0"></div></div>
			<div class="x-small text-secondary mt-1">SoC</div>
			<div id="spark-temp" class="spark mt-1"></div>
		</div></div>
	</div>
	<div class="col">
		<div class="card h-100"><div class="card-body py-2">
			<div class="x-small text-uppercase text-secondary">Uptime</div>
			<div class="lh-1 my-1"><span class="fs-5 fw-semibold" id="st-uptime">–</span></div>
			<div class="x-small text-secondary mt-1">since boot</div>
		</div></div>
	</div>
</div>

<div class="row g-4">
	<!-- Streams -->
	<div class="col-12 col-xl-6">
		<div class="card h-100"><div class="card-body">
			<div class="d-flex align-items-center mb-3">
				<h3 class="m-0 me-auto">Streams</h3>
				<span id="st-daynight" class="badge text-bg-secondary me-2" aria-live="polite">–</span>
				<span class="badge text-bg-light border" title="HLS clients">HLS <span id="st-hls">0</span></span>
			</div>
			<div id="streams" class="d-flex flex-column gap-3"><div class="text-secondary small">loading…</div></div>
			<div class="d-flex justify-content-between x-small text-secondary mt-3">
				<span>Network ↓ <span id="st-rx">–</span> · ↑ <span id="st-tx">–</span></span>
			</div>
			<div id="spark-net" class="spark mt-1"></div>
		</div></div>
	</div>

	<!-- Device -->
	<div class="col-12 col-md-6 col-xl-3">
		<div class="card h-100"><div class="card-body">
			<h3>Device</h3>
			<dl class="small list mb-0">
				<dt>SoC</dt><dd><%= $soc %> <span class="text-secondary">(<%= $soc_family %>)</span></dd>
				<dt>Sensor</dt><dd><%= $sensor %></dd>
				<dt>Firmware</dt><dd><%= "${fw_version}-${fw_variant}" %></dd>
				<dt>Build</dt><dd class="text-break"><%= $fw_build %></dd>
				<dt>Majestic</dt><dd><%= $mj_version %></dd>
				<% if [ -n "$uboot_version" ]; then %>
					<dt>U-Boot</dt><dd><%= $uboot_version %></dd>
				<% fi %>
			</dl>
		</div></div>
	</div>

	<!-- Network -->
	<div class="col-12 col-md-6 col-xl-3">
		<div class="card h-100"><div class="card-body">
			<h3>Network</h3>
			<dl class="small list mb-0">
				<dt>Host</dt><dd><%= $network_hostname %></dd>
				<dt>Address</dt><dd><%= $network_address %></dd>
				<dt>MAC</dt><dd class="text-break"><%= $network_macaddr %></dd>
				<dt>Link</dt><dd><%= $network_interface %></dd>
				<dt>Gateway</dt><dd><%= $network_gateway %></dd>
			</dl>
		</div></div>
	</div>

	<!-- Storage -->
	<div class="col-12 col-md-6 col-xl-3">
		<div class="card h-100"><div class="card-body">
			<h3>Storage</h3>
			<dl class="small list mb-2">
				<dt>Flash</dt><dd><%= $flash_size %> MB <span class="text-secondary"><%= $flash_type %></span></dd>
			</dl>
			<div class="d-flex justify-content-between x-small mb-1">
				<span class="fw-semibold">Overlay</span><span class="text-secondary"><%= ${overlay_use:-n/a} %></span>
			</div>
			<div id="overlay-bar" class="storage-bar mb-2"></div>
			<div id="overlay-legend" class="storage-legend x-small mb-3"></div>
			<script type="application/json" id="overlay-data">{"total":<%= ${ov_total:-0} %>,"used":<%= ${ov_used:-0} %>,"avail":<%= ${ov_avail:-0} %>,"cats":[<%= $ov_cats %>]}</script>
			<% if [ -n "$sd_rows" ]; then %>
				<% echo "$sd_rows" | while IFS='|' read mnt use pct; do %>
					<div class="d-flex justify-content-between x-small">
						<span class="badge text-bg-success">SD</span>
						<span class="text-secondary"><%= "$mnt — $use ($pct)" %></span>
					</div>
				<% done %>
			<% else %>
				<div class="x-small text-secondary">No SD card detected</div>
			<% fi %>
		</div></div>
	</div>
</div>

<link rel="stylesheet" href="/a/uPlot.min.css">
<script src="/a/uPlot.iife.min.js"></script>
<script src="/a/status.js" defer></script>

<%in p/footer.cgi %>

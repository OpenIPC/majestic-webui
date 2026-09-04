#!/usr/bin/haserl
Content-type: text/html; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache

<!DOCTYPE html>
<html lang="en" data-bs-theme="<% attr_escape "${webui_theme:=dark}" %>">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<!-- the page ships its own light/dark theme; tell Dark Reader to leave colours alone -->
	<meta name="darkreader-lock">
	<title><% html_title %></title>
	<script>if(document.documentElement.getAttribute('data-bs-theme')==='auto')document.documentElement.setAttribute('data-bs-theme',matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');</script>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<!-- The brand fonts come from a CDN, but the page must paint without it
	     (#31): a camera with no internet — or behind a route that blackholes
	     instead of refusing — must not hold first paint on fonts.googleapis.com.
	     media="print" keeps the fetch off the render path; onload promotes the
	     sheet once it actually arrives, and until then the system stack from
	     bootstrap.override.css is what you read. No <noscript> twin: it would
	     be render-blocking again, and without JS this UI is inert anyway. -->
	<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=PT+Mono&display=swap" media="print" onload="this.onload=null;this.media='all'">
	<link rel="stylesheet" href="/a/bootstrap.min.css">
	<link rel="stylesheet" href="/a/bootstrap.override.css">
	<!-- No bootstrap.bundle.min.js: the few behaviours the UI used from it
	     (modals, dropdowns, the navbar toggler, alert dismiss) live in main.js
	     against the same markup and CSS. -->
	<script src="/a/main.js"></script>
	<script src="/a/cameras-switch.js" defer></script>
</head>

<body id="page-<% attr_escape "$pagename" %>" class="<% attr_escape "$fw_variant" %>">
	<nav class="navbar navbar-expand-lg bg-body-tertiary">
		<div class="container">
			<a class="navbar-brand" href="status.cgi"><img alt="Image: OpenIPC logo" height="32" src="/a/logo.svg"><span class="x-small ms-1"><% esc "$fw_variant" %></span></a>
			<button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav" aria-controls="navbarNav" aria-expanded="false" aria-label="Toggle navigation">
				<span class="navbar-toggler-icon"></span>
			</button>
			<div class="collapse navbar-collapse" id="navbarNav">
				<ul class="navbar-nav">
					<!-- The bar is grouped by task, not by which subsystem owns the
					     page: viewing jobs are flat links up front, then what is
					     being configured — the camera, the box it runs on, and the
					     optional services on top. "Majestic" the daemon is not a
					     word here on purpose: newcomers asked what it meant, and
					     the answer was "the settings menu". -->
					<li class="nav-item"><a class="nav-link" href="status.cgi">Dashboard</a></li>
					<li class="nav-item"><a class="nav-link" href="preview.cgi">Live</a></li>
					<!-- Top level rather than under a menu: browsing an archive is
					     a viewing job like Live, and the File Manager route it
					     replaces was the thing nobody found. Same card guard as
					     the SD Card entry below — a camera with no card cannot
					     record, so the page would only ever show its empty state. -->
					<% if [ -e /dev/mmcblk0 ]; then %>
						<li class="nav-item"><a class="nav-link" href="tool-recordings.cgi">Recordings</a></li>
					<% fi %>
					<li class="nav-item dropdown">
						<a aria-expanded="false" class="nav-link dropdown-toggle" data-bs-toggle="dropdown" href="#" id="dropdownCamera" role="button">Camera</a>
						<ul aria-labelledby="dropdownCamera" class="dropdown-menu">
							<li><a class="dropdown-item" href="mj-settings.cgi">Settings</a></li>
							<li><a class="dropdown-item" href="mj-endpoints.cgi">Stream URLs</a></li>
							<li><a class="dropdown-item" href="mj-configuration.cgi">Config file</a></li>
						</ul>
					</li>
					<li class="nav-item dropdown">
						<a aria-expanded="false" class="nav-link dropdown-toggle" data-bs-toggle="dropdown" href="#" id="dropdownSystem" role="button">System</a>
						<ul aria-labelledby="dropdownSystem" class="dropdown-menu">
							<li><h6 class="dropdown-header">Setup</h6></li>
							<li><a class="dropdown-item" href="fw-network.cgi">Network</a></li>
							<li><a class="dropdown-item" href="fw-time.cgi">Time</a></li>
							<li><a class="dropdown-item" href="fw-interface.cgi">Access</a></li>
							<li><h6 class="dropdown-header">Maintenance</h6></li>
							<li><a class="dropdown-item" href="fw-update.cgi">Update</a></li>
							<li><a class="dropdown-item" href="fw-settings.cgi">Backup &amp; Restore</a></li>
							<li><h6 class="dropdown-header">Diagnostics</h6></li>
							<li><a class="dropdown-item" href="info-logs.cgi">Logs</a></li>
							<li><a class="dropdown-item" href="tool-console.cgi">Console</a></li>
							<li><a class="dropdown-item" href="tool-files.cgi">File Manager</a></li>
							<% if [ -e /dev/mmcblk0 ]; then %>
								<li><a class="dropdown-item" href="tool-sdcard.cgi">SD Card</a></li>
							<% fi %>
						</ul>
					</li>
					<li class="nav-item dropdown">
						<a aria-expanded="false" class="nav-link dropdown-toggle" data-bs-toggle="dropdown" href="#" id="dropdownServices" role="button">Services</a>
						<ul aria-labelledby="dropdownServices" class="dropdown-menu">
							<li><h6 class="dropdown-header">Notifications</h6></li>
							<li><a class="dropdown-item" href="ext-openwall.cgi">OpenWall</a></li>
							<li><a class="dropdown-item" href="ext-telegram.cgi">Telegram</a></li>
							<li><a class="dropdown-item" href="ext-ntfy.cgi">Ntfy</a></li>
							<li><h6 class="dropdown-header">Networking</h6></li>
							<li><a class="dropdown-item" href="https://openipc.cloud">P2P network</a></li>
							<li><a class="dropdown-item" href="ext-vtun.cgi">VTun</a></li>
							<li><a class="dropdown-item" href="ext-wireguard.cgi">WireGuard</a></li>
							<li><a class="dropdown-item" href="ext-proxy.cgi">Proxy</a></li>
						</ul>
					</li>
					<!-- Other OpenIPC cameras on this link. Hidden until
					     /a/cameras-switch.js confirms there are peers; inert
					     markup, filled by JS with textContent (peer names are
					     untrusted), so nothing is interpolated server-side. -->
					<li class="nav-item dropdown d-none" id="cam-switch">
						<!-- The label is this camera's own hostname, which the user
						     can set to anything, so it is given a camera glyph and
						     extra weight to read as "the device you are on" rather
						     than another menu word. Not the brand accent: in light
						     theme the navbar IS the brand colour, and the accent
						     vanished into it completely. -->
						<a aria-expanded="false" class="nav-link dropdown-toggle d-inline-flex align-items-center gap-1" data-bs-toggle="dropdown" href="#" id="cam-switch-toggle" role="button">
							<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2z"/>
							</svg>
							<span class="fw-semibold" id="cam-switch-name">This camera</span>
							<!-- "+N" for the other cameras: reads as "N more" rather
							     than a bare count, and stays muted so it does not
							     compete with the accented hostname. -->
							<span class="small fw-normal" id="cam-switch-count"></span>
						</a>
						<ul aria-labelledby="cam-switch-toggle" class="dropdown-menu dropdown-menu-end" id="cam-switch-menu"></ul>
					</li>
					<li class="nav-item nav-push-end"><a class="nav-link" href="#" id="nav-logout" title="Sign out">Sign out</a></li>
				</ul>
			</div>
		</div>
	</nav>

<% if [ -n "$full_bleed" ]; then %>
	<!-- A page that IS its content (preview.cgi, and so far only it). <main> is
	     a flex column: this container holds whatever banners the camera has to
	     raise and collapses to nothing when it has none, and the page body
	     below it takes the rest of the window. Every reading the status strip
	     carries is on the Dashboard, so none of it is lost by leaving it out.
	     The heartbeat writes each of those through a `$('#…')` guard, so an
	     absent strip and an absent footer are already accounted for. -->
	<main class="mj-fullbleed">
		<div class="container">
<% else %>
	<main class="pb-4">
		<div class="container" style="min-height: 85vh">
			<div class="row mt-1 x-small">
				<div class="col-lg-2">
					<div id="pb-memory" class="progress my-1" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar"></div></div>
					<div id="pb-overlay" class="progress my-1" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar"></div></div>
				</div>

				<div class="col-md-6 mb-2">
					<% [ -z "$hide_signature" ] && signature %>
				</div>

				<div class="col-md-6 col-lg-4 mb-2 text-end">
					<!-- The reader's clock, not the camera's. This bar used to print
					     the camera's wall time and its timezone label — "8/29/2026,
					     5:47:07 PM Etc/GMT" — which is a time nobody looking at the
					     page is in: a camera whose zone was never set says GMT, and
					     the reader is wherever they are. Both spans are filled by
					     main.js; the camera's clock survives only as the drift
					     warning, which appears when it is actually wrong. -->
					<div><time id="time-local"></time><span id="clock-drift" role="status" aria-live="polite"></span></div>
					<div class="text-secondary" id="soc-temp"></div>
				</div>
			</div>
<% fi %>

<% if [ -z "$network_gateway" ]; then %>
<div class="alert alert-warning">
	<p class="mb-0">Internet connection not available, please <a href="fw-network.cgi">check your network settings</a>.</p>
</div>
<% fi %>

<% if [ "$network_macaddr" = "00:00:23:34:45:66" ] && [ -f /etc/shadow- ] && [ -n $(grep root /etc/shadow- | cut -d: -f2) ]; then %>
<div class="alert alert-danger">
	<%in p/address.cgi %>
</div>
<% fi %>

<% if [ ! -e $(get_config) ]; then %>
<div class="alert alert-danger">
	<p class="mb-0">Camera configuration not found, please <a href="mj-configuration.cgi">check the configuration file</a>.</p>
</div>
<% fi %>

<% if [ -e /tmp/system-reboot ]; then %>
<div class="alert alert-danger">
	<h3>Warning.</h3>
	<p>System settings have been updated, restart to apply pending changes.</p>
	<span class="d-flex gap-3">
		<a class="btn btn-danger" href="fw-restart.cgi"
			data-confirm="Restart the camera now?&#10;&#10;Settings are kept. Video and recording stop for about half a minute while it comes back.">Restart camera</a>
	</span>
</div>
<% fi %>

<% if [ -z "$hide_title" ]; then %><h2><%= $page_title %></h2><% fi %>
<% log_read %>
<% if [ -n "$full_bleed" ]; then %>
	<!-- Banners and flash messages end here; what follows is the page body,
	     which on a full-bleed page is a sibling of this container rather than
	     a child of it, and takes the height the banners did not. -->
	</div>
<% fi %>

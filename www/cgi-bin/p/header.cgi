#!/usr/bin/haserl
<%in p/pages.cgi %>
<%
# The page's name, from the one place it is written. This runs here rather
# than in p/common.cgi because a page's own block sits between the two
# includes -- so a page that needs a name this file cannot know (one built
# from a filename, say) can still set page_title itself and be left alone.
# Nothing does today; the lint rule accepts either.
[ -z "$page_title" ] && page_title=$(page_label "$pagename")
%>Content-type: text/html; charset=UTF-8
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
	<script src="/a/update-check.js" defer></script>
</head>

<body id="page-<% attr_escape "$pagename" %>" class="<% attr_escape "$fw_variant" %>">
	<nav class="navbar navbar-expand-lg bg-body-tertiary">
		<div class="container">
			<a class="navbar-brand" href="dashboard.cgi"><img alt="Image: OpenIPC logo" height="32" src="/a/logo.svg"><span class="x-small ms-1"><% esc "$fw_variant" %></span></a>
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
					<li class="nav-item"><a class="nav-link" href="dashboard.cgi"><% page_label dashboard %></a></li>
					<li class="nav-item"><a class="nav-link" href="live.cgi"><% page_label live %></a></li>
					<!-- Top level rather than under a menu: browsing an archive is
					     a viewing job like Live, and the File Manager route it
					     replaces was the thing nobody found. Same card guard as
					     the SD Card entry below — a camera with no card cannot
					     record, so the page would only ever show its empty state. -->
					<% if [ -e /dev/mmcblk0 ]; then %>
						<li class="nav-item"><a class="nav-link" href="recordings.cgi"><% page_label recordings %></a></li>
					<% fi %>
					<li class="nav-item dropdown">
						<a aria-expanded="false" class="nav-link dropdown-toggle" data-bs-toggle="dropdown" href="#" id="dropdownCamera" role="button">Camera</a>
						<ul aria-labelledby="dropdownCamera" class="dropdown-menu">
							<li><a class="dropdown-item" href="camera.cgi"><% page_label camera %></a></li>
							<li><a class="dropdown-item" href="stream-urls.cgi"><% page_label stream-urls %></a></li>
							<li><a class="dropdown-item" href="config.cgi"><% page_label config %></a></li>
						</ul>
					</li>
					<li class="nav-item dropdown">
						<a aria-expanded="false" class="nav-link dropdown-toggle" data-bs-toggle="dropdown" href="#" id="dropdownSystem" role="button">System</a>
						<ul aria-labelledby="dropdownSystem" class="dropdown-menu">
							<li><h6 class="dropdown-header">Setup</h6></li>
							<li><a class="dropdown-item" href="network.cgi"><% page_label network %></a></li>
							<li><a class="dropdown-item" href="time.cgi"><% page_label time %></a></li>
							<li><a class="dropdown-item" href="access.cgi"><% page_label access %></a></li>
							<li><h6 class="dropdown-header">Maintenance</h6></li>
							<li><a class="dropdown-item" href="update.cgi"><% page_label update %></a></li>
							<li><a class="dropdown-item" href="backup.cgi"><% page_label backup %></a></li>
							<li><h6 class="dropdown-header">Diagnostics</h6></li>
							<li><a class="dropdown-item" href="logs.cgi"><% page_label logs %></a></li>
							<li><a class="dropdown-item" href="console.cgi"><% page_label console %></a></li>
							<li><a class="dropdown-item" href="files.cgi"><% page_label files %></a></li>
							<% if [ -e /dev/mmcblk0 ]; then %>
								<li><a class="dropdown-item" href="sdcard.cgi"><% page_label sdcard %></a></li>
							<% fi %>
						</ul>
					</li>
					<li class="nav-item dropdown">
						<a aria-expanded="false" class="nav-link dropdown-toggle" data-bs-toggle="dropdown" href="#" id="dropdownServices" role="button">Services</a>
						<ul aria-labelledby="dropdownServices" class="dropdown-menu">
							<li><h6 class="dropdown-header">Notifications</h6></li>
							<li><a class="dropdown-item" href="openwall.cgi"><% page_label openwall %></a></li>
							<li><a class="dropdown-item" href="telegram.cgi"><% page_label telegram %></a></li>
							<li><a class="dropdown-item" href="ntfy.cgi"><% page_label ntfy %></a></li>
							<li><h6 class="dropdown-header">Networking</h6></li>
							<li><a class="dropdown-item" href="https://openipc.cloud">P2P network</a></li>
							<li><a class="dropdown-item" href="vtun.cgi"><% page_label vtun %></a></li>
							<li><a class="dropdown-item" href="wireguard.cgi"><% page_label wireguard %></a></li>
							<li><a class="dropdown-item" href="proxy.cgi"><% page_label proxy %></a></li>
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
	<!-- A page that IS its content (live.cgi, and so far only it). <main> is
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

<%# The banners the camera raises, all four in the one shape the rest of the UI
    uses -- p/common.cgi's `notice`, over .mj-notice. They were Bootstrap's
    filled .alert until the notice component was lifted out of the Dashboard,
    each with whatever markup its author reached for: an h3 at 28px on one, a
    bare paragraph on two, a form on the fourth.

    Each says what is wrong and then what it costs, and points at the page that
    fixes it. None of them carries the fix itself: a control inside a banner is
    a banner that can never be one line, and these are on every page at once. %>

<% if [ -z "$network_gateway" ]; then %>
<%# What is known here is the absence of a default route, and that is what the
    sentence says. Naming the time server was a consequence nobody measured:
    an NTP server on the camera's own subnet is reachable with no gateway at
    all, and a static-network camera pointed at one would have been told every
    page that its clock was broken when it was not. %>
<% notice warn '<b>No default gateway</b> &mdash; nothing outside the local network is reachable from this camera.' '<a class="btn btn-sm btn-primary" href="network.cgi">Network settings</a>' %>
<% fi %>

<%# The address the firmware falls back to when the camera's own was not put
    back after flashing. The fix is network.cgi's own "Change MAC address"
    card, which has been there all along -- the banner used to carry a second
    copy of that form, on every page, until somebody used one of them. %>
<% if [ "$network_macaddr" = "00:00:23:34:45:66" ] && [ -f /etc/shadow- ] && [ -n $(grep root /etc/shadow- | cut -d: -f2) ]; then %>
<% notice danger "<b>This camera's MAC address is a placeholder</b> &mdash; <code>00:00:23:34:45:66</code> is what the firmware falls back to when the camera's own address was not put back after flashing, and two cameras carrying it on one network will collide." '<a class="btn btn-sm btn-primary" href="network.cgi#mac">Set the MAC address</a>' %>
<% fi %>

<% if [ ! -e $(get_config) ]; then %>
<% notice danger '<b>No camera configuration found</b> &mdash; there is no settings file for the camera to read.' '<a class="btn btn-sm btn-primary" href="config.cgi">Configuration file</a>' %>
<% fi %>

<%# Warning rather than danger: it reports something you asked for and have not
    finished, not something broken. The button keeps btn-danger because main.js
    hangs the confirmation prompt off that class -- restyling it would quietly
    drop the "restart now?" question. %>
<%# Filled by /a/update-check.js once it has the feed. Server-rendered banners
    above are things the camera knows on its own; this one needs the public
    release-notes feed, which the reader's browser fetches -- the camera itself
    never reaches the internet for it. Empty, and staying empty, is the correct
    result on a camera with no route out. %>
<%# Data attributes rather than a <script> block: attr_escape is the escaping
    this file already trusts everywhere else, and nothing the camera reports
    can close the tag it sits in. %>
<div id="update-notice"
     data-mj-version="<% attr_escape "$mj_version" %>"
     data-soc-vendor="<% attr_escape "$soc_vendor" %>"></div>

<% if [ -e /tmp/system-reboot ]; then %>
<% notice warn '<b>Settings are waiting for a restart</b> &mdash; video and recording stop for about half a minute while the camera comes back.' '<a class="btn btn-sm btn-danger" href="restart.cgi" data-confirm="Restart the camera now?&#10;&#10;Settings are kept. Video and recording stop for about half a minute while it comes back.">Restart camera</a>' %>
<% fi %>

<% if [ -z "$hide_title" ]; then %><h2><%= $page_title %></h2><% fi %>
<% log_read %>
<% if [ -n "$full_bleed" ]; then %>
	<!-- Banners and flash messages end here; what follows is the page body,
	     which on a full-bleed page is a sibling of this container rather than
	     a child of it, and takes the height the banners did not. -->
	</div>
<% fi %>

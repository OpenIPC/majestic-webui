#!/usr/bin/haserl
<%in p/common.cgi %>

<%
# full_bleed asks header.cgi and footer.cgi for a page that IS its content: no
# container, no status strip, no footer, and a body that is exactly the
# viewport with the stage taking whatever the navbar and any banner leave.
#
# The strip goes because all four of its readings -- the memory and overlay
# bars, the signature, the clock, the SoC temperature -- are on the Dashboard,
# which is where somebody goes to read them; here they were a band of small
# text between the menu and the picture. Only this page asks for it: the same
# argument applies to the other twenty, but that is a different change.
page_title="Live View"; hide_title=1; full_bleed=1
%>
<%in p/header.cgi %>
<!-- No page heading: the nav underlines "Live", and a heading here would be a
     row taken off the picture.

     This page is deliberately settings-free: it is the page every user of a
     future multi-user system gets, read-only, so nothing on it changes the
     camera. Every setting -- including the night/IR/light toggles that used
     to sit here -- lives in mj-settings.cgi, whose Live section pairs the
     same preview with the real-time adjustments. The one exception is the
     PTZ pad, which steers rather than configures; it stays on the video
     until the multi-user split decides who may steer.

     No "Stream URLs" link either: it is a menu item under Camera, and a
     second copy under the picture was the only body text on the page. -->

<% preview %>
<% if [ -n "$ptz_support" ]; then %>
	<%in p/motor.cgi %>
<% fi %>

<script src="/a/preview.js"></script>
<script src="/a/preview-webrtc.js"></script>
<script src="/a/preview-swap.js"></script>
<script src="/a/preview-wasm.js"></script>
<script src="/a/preview-transport.js"></script>
<script src="/a/charts.js"></script>
<script src="/a/preview-adapt.js"></script>
<script src="/a/preview-stats.js"></script>
<!-- preview-zoom.js before preview-page.js, and that order is load-bearing:
     the page registers a chip repaint with the module, so the module has to
     exist by the time the page runs. The dependency is one-way and guarded --
     the module needs nothing from the page, and the page checks before it
     asks -- so a build missing either file still works. -->
<script src="/a/preview-zoom.js"></script>
<script src="/a/preview-page.js"></script>
<script src="/a/preview-hero.js"></script>

<%in p/footer.cgi %>

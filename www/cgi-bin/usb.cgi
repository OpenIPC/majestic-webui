#!/usr/bin/haserl
<%in p/common.cgi %>
<%
# The USB port has one job at a time, and this page is where that is chosen.
#
# Two halves with two different owners, which is why there is no POST handler
# here. The role belongs to the DWC3 controller and to /etc/usbmode, and goes
# through j/usb.cgi. Everything majestic knows -- whether the second camera is
# on, what the PC is offered -- belongs to majestic and goes to its API from
# a/usb.js. Nothing on this page reads the camera's configuration file.
#
# The per-role tuning lives in Settings, on the leaf this page links to. Two
# places to change one thing is worse than one place to find it, so what is
# here is the choice, and what is there is everything that follows from it.
%>
<%in p/header.cgi %>

<div class="row g-4">
	<div class="col-12 col-lg-7">
		<div class="card"><div class="card-body">
			<% card_head "What the USB port is for" %>
			<p class="small text-secondary">
				There is one port and it can only do one of these at a time.
			</p>

			<%
			# Radios rather than a switch or a select: three states that exclude
			# each other, each needing a sentence to be understandable, and the
			# consequence of picking the wrong one is that a camera stops
			# appearing somewhere. The row shape is copied from what the field_*
			# helpers emit -- see access.cgi and time.cgi, which hand-roll a row
			# for the same reason -- so it inherits the form's spacing rather
			# than inventing any.
			%>
			<form id="usb-form" action="javascript:void(0)" autocomplete="off">
				<div class="form-check mb-3">
					<input class="form-check-input" type="radio" name="usb_role" id="usb_role_host" value="host">
					<label class="form-check-label" for="usb_role_host">
						<b>A second camera</b>
						<span class="d-block hint text-secondary">
							A USB webcam is plugged into this camera. Its picture
							is served alongside the built-in one.
						</span>
					</label>
				</div>
				<div class="form-check mb-3">
					<input class="form-check-input" type="radio" name="usb_role" id="usb_role_device" value="device">
					<label class="form-check-label" for="usb_role_device">
						<b>A webcam for a PC</b>
						<span class="d-block hint text-secondary">
							A computer on the other end of the cable sees this
							camera as an ordinary USB webcam.
						</span>
					</label>
				</div>
				<div class="form-check mb-3">
					<input class="form-check-input" type="radio" name="usb_role" id="usb_role_off" value="off">
					<label class="form-check-label" for="usb_role_off">
						<b>Nothing</b>
						<span class="d-block hint text-secondary">
							The port stays powered and unused.
						</span>
					</label>
				</div>

				<button type="submit" class="btn btn-primary" id="usb-apply">Apply</button>
				<span id="usb-msg" class="small ms-2"></span>
			</form>

			<noscript>
				<p class="small text-danger mt-3">
					This page needs JavaScript to change the port.
				</p>
			</noscript>

			<p class="small text-secondary mt-3 mb-0">
				Resolution, frame rate and codec are on the USB page of
				<a href="camera.cgi?tab=usbcam">Settings</a>.
			</p>
		</div></div>
	</div>

	<div class="col-12 col-lg-5">
		<div class="card"><div class="card-body">
			<% card_head "Right now" %>
			<div id="usb-status" class="small text-secondary">Looking&hellip;</div>
		</div></div>
	</div>
</div>

<script src="/a/usb.js" defer></script>

<%in p/footer.cgi %>

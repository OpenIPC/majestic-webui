#!/usr/bin/haserl
<%in p/common.cgi %>
<%
# The cellular modem's messages, and its operator's short codes.
#
# What a SIM receives is mostly the operator talking: the activation notice,
# the receipt for a top-up, a warning that the money is about to run out. The
# camera's owner had to read those by typing AT commands into a console and
# decoding hex by hand. This page does it for any modem and any operator --
# see www/a/sms-pdu.js for why that takes no table of either.
#
# The page is markup only. j/sms.cgi carries what the modem says, and
# www/a/sms.js draws it, because a message has to be decoded before it can be
# shown and the decoder lives where the tests can reach it.
%>
<%in p/header.cgi %>

<% if [ -z "$(ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null)" ]; then %>

<%# Reachable only by typing the URL: the menu entry is guarded the same way. %>
<% notice info '<b>No cellular modem is attached to this camera</b> &mdash; there is no serial port a modem would answer on.' %>

<% else %>

<div class="row g-4">
	<div class="col-12 col-xl-8">
		<div class="card"><div class="card-body">
			<% card_head "Messages" '<span id="sms-store"></span>' %>
			<div class="d-flex flex-wrap gap-2 mb-3">
				<button type="button" class="btn btn-sm btn-outline-primary" id="sms-reload">Refresh</button>
				<button type="button" class="btn btn-sm btn-outline-danger" id="sms-clear" disabled>Delete all</button>
				<span id="sms-msg" class="small align-self-center"></span>
			</div>
			<div id="sms-list" class="small text-secondary">Reading the modem&hellip;</div>
			<noscript><p class="small text-danger">This page needs JavaScript to read the modem.</p></noscript>
		</div></div>
	</div>

	<div class="col-12 col-xl-4">
		<div class="card mb-4"><div class="card-body">
			<% card_head "Balance and packages" %>
			<p class="small text-secondary">
				A short code like <code>*100#</code> asks the operator for the
				balance or what is left of a package. Which code does what is up to
				the operator &mdash; its website lists them. A code that opens a
				menu shows the menu&rsquo;s first screen and nothing more.
			</p>
			<form id="ussd-form" class="d-flex gap-2" action="javascript:void(0)" autocomplete="off">
				<input type="text" class="form-control form-control-sm" id="ussd-code" placeholder="*100#" inputmode="tel" pattern="[0-9*#]{1,32}" maxlength="32" required aria-label="Short code">
				<button type="submit" class="btn btn-sm btn-primary" id="ussd-send">Ask</button>
			</form>
			<div id="ussd-reply" class="small mt-3" hidden></div>
		</div></div>

		<div class="card"><div class="card-body">
			<% card_head "Send a message" %>
			<form id="send-form" action="javascript:void(0)" autocomplete="off">
				<input type="tel" class="form-control form-control-sm mb-2" id="send-to" placeholder="+1 555 0100" maxlength="24" required aria-label="Phone number">
				<textarea class="form-control form-control-sm mb-1" id="send-text" rows="4" maxlength="1530" required aria-label="Text"></textarea>
				<p class="x-small text-secondary mb-2" id="send-count">&nbsp;</p>
				<button type="submit" class="btn btn-sm btn-primary" id="send-go">Send</button>
				<span id="send-msg" class="small ms-2"></span>
			</form>
		</div></div>
	</div>
</div>

<script src="/a/sms-pdu.js" defer></script>
<script src="/a/sms.js" defer></script>

<% fi %>

<%in p/footer.cgi %>

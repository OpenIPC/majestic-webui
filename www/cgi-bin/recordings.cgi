#!/usr/bin/haserl
<%in p/common.cgi %>
<%in p/header.cgi %>

<!-- Two banners, and they are not interchangeable. #rec-health is about the
     card and stays put for as long as the card is in trouble; #rec-note is the
     transient one the player writes to and clears on every clip and day change,
     so a card warning parked in it would be wiped by the first seek. -->
<div id="rec-health" class="d-none"></div>
<div id="rec-note" class="d-none"></div>

<noscript>
	<div class="alert alert-warning">This page reads the archive off the card in the browser, so it needs JavaScript.</div>
</noscript>

<!-- Hidden until recordings.js knows there is an archive to show. Almost all of
     this — a full-width player, a ribbon, a Clips card — means nothing until the
     card has been read, and two fetches later it may turn out there is nothing
     on it. Painted first and then withdrawn, it flashes a whole video player at
     someone for a fifth of a second and takes it away again. -->
<div id="rec-main" hidden>

	<div id="rec-daynav" class="d-flex flex-wrap align-items-center gap-2 mb-3"></div>

	<div class="row g-4">
		<div class="col-12 col-lg-8">
			<div class="card"><div class="card-body">

				<div class="rec-stage">
					<video id="rec-video" class="rec-video" controls playsinline preload="metadata"></video>
				</div>

				<div class="d-flex flex-wrap align-items-center gap-2 mt-2">
					<span class="small text-secondary" id="rec-status"></span>
					<button class="btn btn-sm btn-outline-secondary ms-auto" id="rec-dl" type="button">Save whole clip</button>
				</div>

				<div class="rec-lbl mt-3">Whole day</div>
				<div class="rec-strip" id="rec-strip"></div>
				<!-- The camera's own 24 hours. Relabelled by recordings.js when the
				     viewer asks to read the day on their clock instead; left exactly
				     as written here when the two zones agree, which is most cameras. -->
				<div class="rec-hours" id="rec-hours">
					<span>00</span><span>02</span><span>04</span><span>06</span><span>08</span><span>10</span>
					<span>12</span><span>14</span><span>16</span><span>18</span><span>20</span><span>22</span><span>24</span>
				</div>

				<div class="d-flex justify-content-between align-items-center mt-3">
					<span class="rec-lbl" id="rec-view-label"></span>
					<span class="x-small text-secondary">drag to scrub · shift-drag to select · scroll to zoom</span>
				</div>
				<div class="rec-band" id="rec-band"></div>

				<!-- Still reserved, and still deliberately empty, but for a narrower
				     reason than before. Recording on motion (records.mode) writes one
				     clip per event, so in that mode the band above IS the event record
				     and drawing it twice would say nothing new. What no camera writes
				     is where the movement was WITHIN a clip, which is the only thing
				     this lane could add — so it stays empty until something records
				     that. The caption below is set from the mode by recordings.js. -->
				<div class="rec-motion"></div>
				<div class="rec-ticks" id="rec-ticks"></div>
				<div class="x-small text-secondary mt-1" id="rec-motion-note">Motion — lights up once the camera records detection events</div>

				<div id="rec-export" class="d-none"></div>

			</div></div>
		</div>

		<div class="col-12 col-lg-4">
			<div class="card h-100"><div class="card-body">
				<%# "newest first" is exactly what the head's note is for, so the
				    hand-rolled flex row that held the two apart is gone %>
				<% card_head "Clips" "newest first" %>
				<div id="rec-clips" class="mt-3"><div class="text-secondary small">loading…</div></div>
			</div></div>
		</div>
	</div>

	<div class="card mt-4" id="rec-storage-card" hidden><div class="card-body">
		<div id="rec-storage"></div>
	</div></div>

</div>

<script src="/a/timeline.js"></script>
<script src="/a/mp4index.js"></script>
<script src="/a/recordings.js" defer></script>

<%in p/footer.cgi %>

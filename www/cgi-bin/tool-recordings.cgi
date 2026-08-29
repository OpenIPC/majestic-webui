#!/usr/bin/haserl
<%in p/common.cgi %>
<% page_title="Recordings" %>
<%in p/header.cgi %>

<div id="rec-note" class="d-none"></div>

<div id="rec-main">

	<div id="rec-daynav" class="d-flex flex-wrap align-items-center gap-2 mb-3"></div>

	<div class="row g-4">
		<div class="col-12 col-lg-8">
			<div class="card"><div class="card-body">

				<div class="rec-stage">
					<video id="rec-video" class="rec-video" controls playsinline preload="metadata"></video>
				</div>

				<div class="d-flex flex-wrap align-items-center gap-2 mt-2">
					<span class="small text-secondary" id="rec-status"></span>
					<button class="btn btn-sm btn-outline-secondary mj-push-end" id="rec-dl" type="button">Save whole clip</button>
				</div>

				<div class="rec-lbl mt-3">Whole day</div>
				<div class="rec-strip" id="rec-strip"></div>
				<div class="rec-hours">
					<span>00</span><span>02</span><span>04</span><span>06</span><span>08</span><span>10</span>
					<span>12</span><span>14</span><span>16</span><span>18</span><span>20</span><span>22</span><span>24</span>
				</div>

				<div class="d-flex justify-content-between align-items-center mt-3">
					<span class="rec-lbl" id="rec-view-label"></span>
					<span class="x-small text-secondary">drag to scrub · shift-drag to select · scroll to zoom</span>
				</div>
				<div class="rec-band" id="rec-band"></div>

				<!-- Reserved, and deliberately empty. Majestic's motion detection is
				     hardware-assisted but is never written to the card, so there is no
				     event data to draw here yet. -->
				<div class="rec-motion"></div>
				<div class="rec-ticks" id="rec-ticks"></div>
				<div class="x-small text-secondary mt-1">Motion — lights up once the camera records detection events</div>

				<div id="rec-export" class="d-none"></div>

			</div></div>
		</div>

		<div class="col-12 col-lg-4">
			<div class="card h-100"><div class="card-body">
				<div class="d-flex justify-content-between align-items-center">
					<h3 class="m-0">Clips</h3>
					<span class="x-small text-secondary">newest first</span>
				</div>
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

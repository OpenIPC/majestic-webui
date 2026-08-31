<!-- PTZ pad(s). Emitted after the player (preview() has already closed the
     stage by the time this include runs) and hidden: preview-ptz.js relocates
     everything into the stage's #mj-ptz mount and unhides it, so a failed
     script leaves no stray pad below the video. Real buttons with names — the
     emoji pads before this read as glyph soup to a screen reader and took no
     keyboard at all.

     Which pad depends on the backend common.cgi detected. The stepped
     backends (gpio-motors, motor) take eight directions with magnitudes; the
     Pelco-D backend (btzoom) speaks four directions in fixed timed pulses and
     adds zoom and focus.

     The glyphs are gone. Every arrow was Unicode geometry (U+25B2 and
     friends) and the two focus buttons were emoji diamonds, U+1F536 and
     U+1F537, carried over from the old sandbox pad — a shape that says
     nothing about focus, in a typeface nobody controls. They are inline SVG
     on a 20px grid now, the same set the rest of the stage uses.

     Zoom and focus also gained the words they send. A magnifier is read by
     everybody, so zoom keeps its icon and adds WIDE/TELE; focus has no glyph
     anyone decodes — photography's flower and mountain mean close-up and
     landscape MODES on a stills camera, not "pull focus nearer" on a moving
     lens — so NEAR and FAR carry it, with the icon holding only the idea of
     focus: one bracket frame, its subject large for near and small for far.
     Those four words are literally what the buttons send. -->
<% if [ "$ptz_backend" = "pelco" ]; then %>
<div id="mj-ptz-fn" class="mj-ptz-fn" role="group" aria-label="Zoom and focus" hidden>
	<span class="mj-ptz-group">Zoom</span>
	<button type="button" class="mj-ptz-fnbtn" data-act="wide" aria-label="Zoom out" title="Zoom out (wide)">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
			<circle cx="8.8" cy="8.8" r="5.6"></circle><path d="M12.9 12.9 17 17M6.4 8.8h4.8"></path>
		</svg>
		<span>Wide</span>
	</button>
	<button type="button" class="mj-ptz-fnbtn" data-act="tele" aria-label="Zoom in" title="Zoom in (tele)">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
			<circle cx="8.8" cy="8.8" r="5.6"></circle><path d="M12.9 12.9 17 17M6.4 8.8h4.8M8.8 6.4v4.8"></path>
		</svg>
		<span>Tele</span>
	</button>
	<span class="mj-ptz-group">Focus</span>
	<button type="button" class="mj-ptz-fnbtn" data-act="near" aria-label="Focus near" title="Pull focus nearer">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M3.2 7V3.6h3.4M16.8 7V3.6h-3.4M3.2 13v3.4h3.4M16.8 13v3.4h-3.4"></path>
			<circle cx="10" cy="10" r="3.1"></circle>
		</svg>
		<span>Near</span>
	</button>
	<button type="button" class="mj-ptz-fnbtn" data-act="far" aria-label="Focus far" title="Push focus further away">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M3.2 7V3.6h3.4M16.8 7V3.6h-3.4M3.2 13v3.4h3.4M16.8 13v3.4h-3.4"></path>
			<circle cx="10" cy="10" r="1.4"></circle>
		</svg>
		<span>Far</span>
	</button>
</div>
<div id="mj-ptz-pad" class="mj-ptz-pad" role="group" aria-label="Pan and tilt" hidden>
	<span class="mj-ptz-void"></span>
	<button type="button" class="mj-ptz-btn" data-act="up" aria-label="Tilt up">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 12.4 10 7.6l4.6 4.8"></path></svg>
	</button>
	<span class="mj-ptz-void"></span>
	<button type="button" class="mj-ptz-btn" data-act="left" aria-label="Pan left">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.4 5.4 7.6 10l4.8 4.6"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn mj-ptz-stop" data-act="stop" aria-label="Stop" title="Stop">
		<svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.4" fill="currentColor"></rect></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-act="right" aria-label="Pan right">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.6 5.4 12.4 10l-4.8 4.6"></path></svg>
	</button>
	<span class="mj-ptz-void"></span>
	<button type="button" class="mj-ptz-btn" data-act="down" aria-label="Tilt down">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 7.6 10 12.4l4.6-4.8"></path></svg>
	</button>
	<span class="mj-ptz-void"></span>
</div>
<% else %>
<div id="mj-ptz-pad" class="mj-ptz-pad" role="group" aria-label="Pan and tilt" hidden>
	<button type="button" class="mj-ptz-btn" data-dir="ul" aria-label="Pan up-left">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 12.6V6.6h6"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-dir="uc" aria-label="Tilt up">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 12.4 10 7.6l4.6 4.8"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-dir="ur" aria-label="Pan up-right">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.4 6.6h6v6"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-dir="lc" aria-label="Pan left">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.4 5.4 7.6 10l4.8 4.6"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn mj-ptz-stop" data-dir="cc" aria-label="Center" title="Centre">
		<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="3.4"></circle></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-dir="rc" aria-label="Pan right">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.6 5.4 12.4 10l-4.8 4.6"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-dir="dl" aria-label="Pan down-left">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 7.4v6h6"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-dir="dc" aria-label="Tilt down">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 7.6 10 12.4l4.6-4.8"></path></svg>
	</button>
	<button type="button" class="mj-ptz-btn" data-dir="dr" aria-label="Pan down-right">
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.4 7.4v6h-6"></path></svg>
	</button>
</div>
<% fi %>
<script src="/a/preview-ptz.js"></script>

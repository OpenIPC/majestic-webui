<!-- PTZ pad(s). Emitted after the player (preview() has already closed the
     stage by the time this include runs) and hidden: preview-ptz.js relocates
     everything into the stage's #mj-ptz mount and unhides it, so a failed
     script leaves no stray pad below the video. Real buttons with names — the
     emoji pads before this read as glyph soup to a screen reader and took no
     keyboard at all.

     Which pad depends on the backend common.cgi detected. The stepped
     backends (gpio-motors, motor) take eight directions with magnitudes; the
     Pelco-D backend (btzoom) speaks four directions in fixed timed pulses and
     adds what the old sandbox pad had: zoom (−/+) and focus (the orange and
     blue diamonds its users already know). -->
<% if [ "$ptz_backend" = "pelco" ]; then %>
<div id="mj-ptz-fn" class="mj-ptz-pad mj-ptz-fn" role="group" aria-label="Zoom and focus" hidden>
	<button type="button" class="mj-ptz-btn" data-act="wide" aria-label="Zoom out" title="Zoom out">−</button>
	<button type="button" class="mj-ptz-btn" data-act="tele" aria-label="Zoom in" title="Zoom in">+</button>
	<button type="button" class="mj-ptz-btn" data-act="near" aria-label="Focus near" title="Focus near">🔶</button>
	<button type="button" class="mj-ptz-btn" data-act="far" aria-label="Focus far" title="Focus far">🔷</button>
</div>
<div id="mj-ptz-pad" class="mj-ptz-pad" role="group" aria-label="Pan and tilt" hidden>
	<span class="mj-ptz-void"></span>
	<button type="button" class="mj-ptz-btn" data-act="up" aria-label="Tilt up">▲</button>
	<span class="mj-ptz-void"></span>
	<button type="button" class="mj-ptz-btn" data-act="left" aria-label="Pan left">◀</button>
	<button type="button" class="mj-ptz-btn" data-act="stop" aria-label="Stop" title="Stop">■</button>
	<button type="button" class="mj-ptz-btn" data-act="right" aria-label="Pan right">▶</button>
	<span class="mj-ptz-void"></span>
	<button type="button" class="mj-ptz-btn" data-act="down" aria-label="Tilt down">▼</button>
	<span class="mj-ptz-void"></span>
</div>
<% else %>
<div id="mj-ptz-pad" class="mj-ptz-pad" role="group" aria-label="Pan and tilt" hidden>
	<button type="button" class="mj-ptz-btn" data-dir="ul" aria-label="Pan up-left">◤</button>
	<button type="button" class="mj-ptz-btn" data-dir="uc" aria-label="Tilt up">▲</button>
	<button type="button" class="mj-ptz-btn" data-dir="ur" aria-label="Pan up-right">◥</button>
	<button type="button" class="mj-ptz-btn" data-dir="lc" aria-label="Pan left">◀</button>
	<button type="button" class="mj-ptz-btn" data-dir="cc" aria-label="Center">●</button>
	<button type="button" class="mj-ptz-btn" data-dir="rc" aria-label="Pan right">▶</button>
	<button type="button" class="mj-ptz-btn" data-dir="dl" aria-label="Pan down-left">◣</button>
	<button type="button" class="mj-ptz-btn" data-dir="dc" aria-label="Tilt down">▼</button>
	<button type="button" class="mj-ptz-btn" data-dir="dr" aria-label="Pan down-right">◢</button>
</div>
<% fi %>
<script src="/a/preview-ptz.js"></script>

<!-- PTZ pad. Emitted after the player (preview() has already closed the
     stage by the time this include runs) and hidden: preview-ptz.js relocates
     it into the stage's #mj-ptz mount and unhides it, so a failed script
     leaves no stray pad below the video. Real buttons with names — the emoji
     pad before this read as glyph soup to a screen reader and took no
     keyboard at all. -->
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
<script src="/a/preview-ptz.js"></script>

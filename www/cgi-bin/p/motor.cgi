<hr class="mb-3"/>
<div class="motor">
	<div class="col">
		<button class="btn btn-motor" data-dir="ul">↖️</button>
		<button class="btn btn-motor" data-dir="uc">⬆️</button>
		<button class="btn btn-motor" data-dir="ur">↗️</button>
	</div>
	<div class="col">
		<button class="btn btn-motor" data-dir="lc">⬅️</button>
		<button class="btn btn-motor" data-dir="cc">🆗</button>
		<button class="btn btn-motor" data-dir="rc">➡️</button>
	</div>
	<div class="col">
		<button class="btn btn-motor" data-dir="dl">↙️</button>
		<button class="btn btn-motor" data-dir="dc">⬇️</button>
		<button class="btn btn-motor" data-dir="dr">↘️</button>
	</div>
</div>

<script>
(function () {
	const STEP = 5;
	const PHASE_MS = 10;
	const TICK_MS = 250;

	let inflight = false;
	let holdTimer = null;

	function fire(dir) {
		if (inflight) return;
		const x = dir.includes("l") ? -STEP : dir.includes("r") ? STEP : 0;
		const y = dir.includes("d") ? -STEP : dir.includes("u") ? STEP : 0;
		inflight = true;
		fetch('/cgi-bin/j/run.cgi?web=' + btoa('gpio-motors ' + x + ' ' + y + ' ' + PHASE_MS))
			.finally(() => { inflight = false; });
	}

	function startHold(dir) {
		stopHold();
		fire(dir);
		holdTimer = setInterval(() => fire(dir), TICK_MS);
	}

	function stopHold() {
		if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
	}

	$$(".motor button").forEach(el => {
		const dir = el.dataset.dir;
		if (dir === "cc") {
			el.addEventListener("click", () => fire(dir));
			return;
		}
		el.addEventListener("mousedown", e => { e.preventDefault(); startHold(dir); });
		el.addEventListener("mouseup", stopHold);
		el.addEventListener("mouseleave", stopHold);
		el.addEventListener("touchstart", e => { e.preventDefault(); startHold(dir); }, { passive: false });
		el.addEventListener("touchend", stopHold);
		el.addEventListener("touchcancel", stopHold);
	});

	window.addEventListener("blur", stopHold);
})();
</script>

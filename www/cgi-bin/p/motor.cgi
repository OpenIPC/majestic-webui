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
function control(dir) {
	let x = dir.includes("l") ? -5 : dir.includes("r") ? 5 : 0;
	let y = dir.includes("d") ? -5 : dir.includes("u") ? 5 : 0;
	fetch('/cgi-bin/j/run.cgi?web=' + btoa('gpio-motors ' + x + ' ' + y + ' 10'));
}

$$(".motor button").forEach(el => {
	el.addEventListener("click", ev => {
		control(ev.target.dataset.dir);
	});
});
</script>

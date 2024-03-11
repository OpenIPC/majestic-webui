<hr class="mb-4"/>
<div class="container motor">
	<div class="col">
		<button class="btn btn-motor" data-dir="ul">↖️</button>
		<button class="btn btn-motor" data-dir="uc">⬆️</button>
		<button class="btn btn-motor" data-dir="ur">↗️</button>
	</div>
	<div class="col">
		<button class="btn btn-motor" data-dir="lc">⬅️</button>
		<button class="btn btn-motor" data-dir="cc">⏺</button>
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
	let step = 3;
	let x = dir.includes("l") ? -step : dir.includes("r") ? step : 0;
	let y = dir.includes("d") ? -step : dir.includes("u") ? step : 0;
	fetch('/cgi-bin/j/run.cgi?web=' + btoa('motor' + ' ' + x + ' ' + y));
}

$$(".motor button").forEach(el => {
	el.addEventListener("click", ev => {
		control(ev.target.dataset.dir);
	});
});
</script>

<hr class="mb-4"/>
<div class="container motor">
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
	let x = dir.includes("l") ? -1 : dir.includes("r") ? 1 : 0;
	let y = dir.includes("d") ? -1 : dir.includes("u") ? 1 : 0;
	fetch('/cgi-bin/j/run.cgi?web=' + btoa('motor ' + x + ' ' + y));
}

$$(".motor button").forEach(el => {
	el.addEventListener("click", ev => {
		control(ev.target.dataset.dir);
	});
});
</script>

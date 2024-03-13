#!/usr/bin/haserl
Content-type: text/html; charset=UTF-8
Date: $(TZ=GMT0 date +'%a, %d %b %Y %T %Z')
Server: <%= $SERVER_SOFTWARE %>
Cache-Control: no-store
Pragma: no-cache

<!DOCTYPE html>
<html lang="en" data-bs-theme="<%= ${webui_theme:=dark} %>">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Restart - OpenIPC</title>
	<link href="/a/bootstrap.min.css" rel="stylesheet">
	<style>
		body {
			text-align: center;
			padding: 1vh;
		}

		h1 {
			font-size: 6vw;
			line-height: 1.5;
			margin-top: 5rem;
		}

		h1 span {
			color:#f80
		}

		h3 {
			font-size: 2vw;
			line-height: 1;
			margin-top: 5rem;
		}

		progress {
			width: 30rem;
			max-width: 90%;
			margin-top: 5rem;
		}
	</style>
</head>

<body>
	<main>
		<h1>OpenIPC</h1>
		<h3>Restarting. Please wait...</h3>
		<progress max="20" value="0"></progress>
	</main>

	<script>
		const u = window.location.protocol + '//' + window.location.host;
		const p = document.querySelector('progress');
		let s = 0;

		function t() {
			s += 1;
			p.value = s;
			(s === p.max) ? g() : setTimeout(t, 1000);
		}

		function g() {
			(async () => {
				await fetch(u, {method: 'HEAD', mode: 'no-cors'}).then(() => {
					window.location.replace(u);
				}).catch(() => {
					s = 0;
					setTimeout(t, 1000);
				})
			})()
		}

		setTimeout(t, 1000);
		<% reboot -d1 %>
	</script>
</body>
</html>

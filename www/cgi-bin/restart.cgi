#!/usr/bin/haserl
Content-type: text/html; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache

<!DOCTYPE html>
<!-- Not escaped, and the include that would make escaping possible is not
     wanted here. This page carries no includes at all: it runs reboot below and
     has to render while the system is going down, so it pulls in no auth gate
     and sources nothing. That also means webui_theme is never set on this page
     and the := always supplies the literal "dark" - there is no device-derived
     value here to escape. Note haserl expands an include tag even inside an
     HTML comment, so this note cannot name the tag it is talking about. -->
<html lang="en" data-bs-theme="<%= ${webui_theme:=dark} %>">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<!-- the page ships its own theme; tell Dark Reader to leave colours alone.
	     Without this the extension recoloured this one page and left every
	     other one alone, since header.cgi has carried the lock since #107 and
	     this page does not include header.cgi. -->
	<meta name="darkreader-lock">
	<title>Restart - OpenIPC</title>
	<link href="/a/bootstrap.min.css" rel="stylesheet">
	<!-- The theme tokens, without which this page renders in stock Bootstrap
	     dark and reads as a different product from the one that sent you here.
	     A second render-blocking stylesheet is a fair cost even on a page that
	     has to paint while the system goes down: it is the same file, from the
	     same httpd, at the same moment as bootstrap.min.css above — and you
	     arrive from a CGI page that has just loaded it, so it is normally a
	     cache hit. If neither arrives there is no page to theme anyway. -->
	<link href="/a/bootstrap.override.css" rel="stylesheet">
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
		<%# a plain heading on purpose: this page carries no includes, so the
		    card_head helper does not exist here %>
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

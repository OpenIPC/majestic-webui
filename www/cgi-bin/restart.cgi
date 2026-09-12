#!/usr/bin/haserl
Content-type: text/html; charset=UTF-8
Cache-Control: no-store
Pragma: no-cache

<!DOCTYPE html>
<!-- Two pages in one file, chosen by method. A POST reboots the camera and
     renders the waiting screen below; anything else renders the question, with
     a button that POSTs.

     That split IS the protection, and nothing lighter was enough (#442). The
     confirmation used to live entirely in the browser, as a confirm() main.js
     hung off the `click` event of the links that offer this page -- which
     covers a plain left click and nothing else. Measured in a real browser: a
     middle click delivers `auxclick` and never `click`, and "Open link in new
     tab" delivers no event at all, so both reached this page and rebooted the
     camera without asking. A prefetcher, a crawler, a restored tab, a typed
     URL and a client with JavaScript off all did the same. A GET cannot now
     reach the reboot at all, whoever sends it and however it was sent.

     Not escaped, and the include that would make escaping possible is not
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
<% if [ "$REQUEST_METHOD" != "POST" ]; then %>
		<%# The question. Answered with 200 rather than refused with 405: this
		    is where an old bookmark, a shared link and every gesture that is
		    not a plain click now arrive, and the useful thing to hand somebody
		    who meant to restart the camera is the button, not an error. The
		    ones that did not mean it -- a prefetch, a crawler -- read a page
		    and leave, which is all they ever wanted. %>
		<h3>Restart the camera?</h3>
		<p class="lead">Settings are kept. Video and recording stop for about
			half a minute while it comes back.</p>
		<form method="post" action="restart.cgi">
			<button type="submit" class="btn btn-danger btn-lg">Restart camera</button>
		</form>
	</main>
</body>
</html>
<% exit 0; fi %>
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

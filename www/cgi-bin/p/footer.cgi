<% if [ -z "$full_bleed" ]; then %>
</div>
<% fi %>
</main>
<% if [ -z "$full_bleed" ]; then %>
<footer class="x-small">
<div class="container pt-3">
<div class="row">
<div class="col col-2">
	<p id="uptime" class="text-secondary"></p>
</div>
<div class="col col-10">
	<%# The ?ref word is how a visit that starts here becomes countable at all:
	    a browser opening this link sends either no referrer or a private
	    address, and neither says which door the person came through. It is a
	    constant -- nothing about the camera, its owner or its firmware rides
	    along with it -- and the site drops it once counted (#549). %>
	<p class="text-end"><a href="https://github.com/openipc/majestic-webui">WebUI</a> by <a href="https://openipc.org/?ref=webui">OpenIPC</a></p>
</div>
</div>
</div>
</footer>
<% fi %>
</body>
</html>

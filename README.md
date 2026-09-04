![OpenIPC logo][1]

WebUI
======

WebUI is a web interface for [OpenIPC Firmware][2],
and is available on port 80 of your camera.

Web interface uses system credentials for access, with _root_ as the username.

A camera fresh from the factory has **no root password at all**, and until one
is set it is *unclaimed*: it streams nothing, answers RTSP and ONVIF with 401,
and serves only the page that claims it. Point a browser at the camera and it
takes you there — set a password, accept the Majestic licence, and you land in
the WebUI signed in. `ssh root@<camera>` claims it just as well, and whichever
door you use the other one sees it immediately. Note that this is the camera's
system password: it is your ssh login too.

Older cameras shipped with _12345_ instead. On those the WebUI sends you
straight to its Access page until you change it.

Signing in through the web form issues a session cookie; that cookie is what
lets the live preview, log viewer and firmware-update progress work in every
browser (Safari does not attach HTTP Basic credentials to a WebSocket
handshake). HTTP Basic still works for `curl`/CLI/webhook access, and the
navigation bar's **Sign out** link ends the session.

### Support

OpenIPC offers two levels of support.

- Free support through the community via [chat][3].
- Paid commercial support directly from the team of developers.

Please consider subscribing for paid commercial support if you intend to use our
product for business. As a paid customer, you will get technical support and
maintenance services directly from our skilled team. Your bug reports and
feature requests will get prioritized attention and expedited solutions. It's a
win-win strategy for both parties, that would contribute to the stability your
business, and help core developers to work on the project full-time.

If you have any specific questions concerning our project, feel free to
[contact us](mailto:dev@openipc.org).

### Participating and Contribution

If you like what we do, and willing to intensify the development, please
consider participating.

You can improve existing code and send us patches. You can add new features
missing from our code.

Remember that you write for embedded linux thus please keep
your code as small and optimized as possible. Avoid using extra libraries like
jQuery, pure JavaScript is quite enough. Use valid HTML5 code. Avoid using
deprecated tags and attributes.

You can help us to write a better documentation, proofread and correct our
websites.

You can just donate some money to cover the cost of development and long-term
maintaining of what we believe is going to be the most stable, flexible, and
open IP Network Camera Framework for users like yourself.

You can make a financial contribution to the project at [Open Collective][4].

Thank you.

<p style="text-align:center"><a href="https://opencollective.com/openipc/contribute/backer-14335/checkout" target="_blank"><img src="https://opencollective.com/webpack/donate/button@2x.png?color=blue" width="375" alt="Open Collective donate button"></a></p>

[1]: https://openipc.org/assets/openipc-logo-black.svg
[2]: https://github.com/openipc/firmware
[3]: https://openipc.org/#telegram-chat-groups
[4]: https://opencollective.com/openipc/contribute/backer-14335/checkout

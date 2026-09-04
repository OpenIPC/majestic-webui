### Project structure

```
├── LICENSE
├── README.md
├── structure.md                          # General list of files in the majestic-webui project and their description
├── sbin
│   ├── ntfy
│   ├── openwall
│   ├── setnetwork
│   ├── telegram
│   └── updatewebui
└── www
    ├── a
    │   ├── bootstrap.bundle.min.js
    │   ├── bootstrap.min.css
    │   ├── bootstrap.override.css
    │   ├── update.js                 # Firmware update over majestic /ws/upgrade WebSocket (update.cgi)
    │   ├── logo.svg
    │   ├── logs.js                      # Live log viewer (majestic /ws/logs WebSocket) for logs.cgi
    │   ├── main.js
    │   ├── mj-settings.js               # Client-side renderer + saver for Majestic settings
    │   ├── preview.js                   # Low-latency H.264/H.265 live player (MSE/fMP4 over majestic /ws/video) for live.cgi
    │   ├── preview.svg
    │   └── timezone.js
    ├── cgi-bin
    │   ├── backup-create.cgi
    │   ├── ntfy.cgi
    │   ├── openwall.cgi
    │   ├── proxy.cgi
    │   ├── telegram.cgi
    │   ├── vtun.cgi
    │   ├── wireguard.cgi
    │   ├── wfb.cgi                   # WFB-NG editor (legacy wfb.conf compat); not in any nav, URL only
    │   ├── editor.cgi
    │   ├── access.cgi
    │   ├── network.cgi
    │   ├── factory-reset.cgi
    │   ├── restart.cgi
    │   ├── config-reset.cgi
    │   ├── backup.cgi
    │   ├── time.cgi
    │   ├── update.cgi
    │   ├── logs.cgi                # Unified live log viewer (Majestic / Kernel / Everything)
    │   ├── info-overlay.cgi
    │   ├── j
    │   │   ├── dmesg.cgi                 # Full kernel ring buffer (dmesg) for the Logs page
    │   │   ├── locale.cgi
    │   │   ├── pulse.cgi
    │   │   ├── ptz.cgi                   # PTZ step (gpio-motors or motor + U-Boot ptz=)
    │   │   ├── run.cgi
    │   │   └── time.cgi
    │   ├── config.cgi
    │   ├── stream-urls.cgi
    │   ├── camera.cgi               # Chrome wrapper: form is rendered + persisted by mj-settings.js
    │   ├── p
    │   │   ├── address.cgi
    │   │   ├── common.cgi
    │   │   ├── footer.cgi
    │   │   ├── fpv_common.cgi            # FPV yaml helpers shared by wfb.cgi
    │   │   ├── header.cgi
    │   │   ├── motor.cgi
    │   │   └── roi.cgi
    │   ├── live.cgi
    │   ├── dashboard.cgi
    │   ├── console.cgi             # Interactive shell terminal (xterm.js over majestic /ws/terminal)
    │   ├── files.cgi
    │   └── sdcard.cgi
    ├── favicon.ico
    ├── index.html
    └── m
        └── img.html
```

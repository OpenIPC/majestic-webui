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
    │   ├── fw-update.js                 # Firmware update over majestic /ws/upgrade WebSocket (fw-update.cgi)
    │   ├── logo.svg
    │   ├── logs.js                      # Live log viewer (majestic /ws/logs WebSocket) for info-logs.cgi
    │   ├── main.js
    │   ├── mj-settings.js               # Client-side renderer + saver for Majestic settings
    │   ├── preview.svg
    │   └── timezone.js
    ├── cgi-bin
    │   ├── ext-backuper.cgi
    │   ├── ext-ntfy.cgi
    │   ├── ext-openwall.cgi
    │   ├── ext-proxy.cgi
    │   ├── ext-telegram.cgi
    │   ├── ext-vtun.cgi
    │   ├── ext-wireguard.cgi
    │   ├── fpv-wfb.cgi                   # WFB-NG editor (backwards compat with legacy wfb.conf)
    │   ├── fw-editor.cgi
    │   ├── fw-interface.cgi
    │   ├── fw-network.cgi
    │   ├── fw-reset.cgi
    │   ├── fw-restart.cgi
    │   ├── fw-restore.cgi
    │   ├── fw-settings.cgi
    │   ├── fw-system.cgi
    │   ├── fw-time.cgi
    │   ├── fw-update.cgi
    │   ├── info-logs.cgi                # Unified live log viewer (Majestic / Kernel / Everything)
    │   ├── info-overlay.cgi
    │   ├── j
    │   │   ├── dmesg.cgi                 # Full kernel ring buffer (dmesg) for the Logs page
    │   │   ├── locale.cgi
    │   │   ├── locale_fpv.cgi            # FPV version of majestic menu
    │   │   ├── pulse.cgi
    │   │   ├── ptz.cgi                   # PTZ step (gpio-motors or motor + U-Boot ptz=)
    │   │   ├── run.cgi
    │   │   └── time.cgi
    │   ├── mj-configuration.cgi
    │   ├── mj-endpoints.cgi
    │   ├── mj-settings.cgi               # Chrome wrapper: form is rendered + persisted by mj-settings.js
    │   ├── p
    │   │   ├── address.cgi
    │   │   ├── common.cgi
    │   │   ├── footer.cgi
    │   │   ├── fpv_common.cgi            # FPV yaml helpers shared by fpv-wfb.cgi
    │   │   ├── header.cgi
    │   │   ├── header_fpv.cgi            # FPV version of general menu
    │   │   ├── motor.cgi
    │   │   └── roi.cgi
    │   ├── preview.cgi
    │   ├── status.cgi
    │   ├── tool-console.cgi             # Interactive shell terminal (xterm.js over majestic /ws/terminal)
    │   ├── tool-files.cgi
    │   └── tool-sdcard.cgi
    ├── favicon.ico
    ├── index.html
    └── m
        └── img.html
```

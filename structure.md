### Project structure

```
├── LICENSE
├── README.md
├── structure.md                          # General list of files in the majestic-webui project and their description
├── sbin
│   ├── openwall
│   ├── setnetwork
│   ├── telegram
│   └── updatewebui
└── www
    ├── a
    │   ├── bootstrap.bundle.min.js
    │   ├── bootstrap.min.css
    │   ├── bootstrap.override.css
    │   ├── logo.svg
    │   ├── main.js
    │   ├── preview.svg
    │   └── timezone.js
    ├── cgi-bin
    │   ├── ext-backuper.cgi
    │   ├── ext-openwall.cgi
    │   ├── ext-proxy.cgi
    │   ├── ext-telegram.cgi
    │   ├── ext-tunnel.cgi
    │   ├── fpv-wfb.cgi                   # WFB-NG editor (backwards compat with legacy wfb.conf)
    │   ├── fw-editor.cgi
    │   ├── fw-interface.cgi
    │   ├── fw-network.cgi
    │   ├── fw-reset.cgi
    │   ├── fw-restart.cgi
    │   ├── fw-restore.cgi
    │   ├── fw-settings.cgi
    │   ├── fw-system.cgi
    │   ├── fw-time.cgi
    │   ├── fw-update.cgi
    │   ├── info-kernel.cgi
    │   ├── info-majestic.cgi
    │   ├── info-overlay.cgi
    │   ├── j
    │   │   ├── locale.cgi
    │   │   ├── locale_fpv.cgi            # FPV version of majestic menu
    │   │   ├── pulse.cgi
    │   │   ├── run.cgi
    │   │   └── time.cgi
    │   ├── mj-configuration.cgi
    │   ├── mj-endpoints.cgi
    │   ├── mj-settings.cgi
    │   ├── p
    │   │   ├── address.cgi
    │   │   ├── common.cgi
    │   │   ├── footer.cgi
    │   │   ├── header.cgi
    │   │   ├── header_fpv.cgi            # FPV version of general menu
    │   │   ├── motor.cgi
    │   │   └── roi.cgi
    │   ├── preview.cgi
    │   ├── status.cgi
    │   ├── tool-console.cgi
    │   ├── tool-files.cgi
    │   └── tool-sdcard.cgi
    ├── favicon.ico
    ├── index.html
    └── m
        └── img.html
```

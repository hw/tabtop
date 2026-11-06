package main

import _ "embed"

//go:embed files.css
var filesCSS string

//go:embed transfers.css
var transfersCSS string

//go:embed highlight.css
var highlightCSS string

//go:embed md-frame.css
var mdFrameCSS string

//go:embed pdf-frame.css
var pdfFrameCSS string

//go:embed epub-frame.css
var epubFrameCSS string

//go:embed desktop-base.css
var desktopBaseCSS string

//go:embed desktop-notices.css
var desktopNoticesCSS string

var pageHead = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<style>" + filesCSS + transfersCSS + `</style>`

// transfersCSS styles the overlay shown while files are dragged over a
// page (see drop.js) and the transfers panel (see ui.js), on the files
// page and, in desktopCSS, the desktop.
// transfersCSS is embedded above.

// desktopCSS is /tabtop/desktop.css, which novnc.js adds to noVNC's page
// for files dropped on the desktop, and tty.js to the terminal's: the
// files page's colours, dark as noVNC is, the transfers panel on the
// right, clear of noVNC's control bar, and over its screen, and the
// browser's own buttons in it rather than noVNC's.
var desktopCSS = desktopBaseCSS + transfersCSS + desktopNoticesCSS

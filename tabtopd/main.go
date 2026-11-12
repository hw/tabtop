// Command tabtopd is the container's only public web endpoint.
//
// It serves the noVNC client, the files page for the desktop user's
// ~/Downloads at /fs/, and a browser terminal at /tty/ (tty.go),
// and streams the desktop's audio (audio.go). Everything private goes
// through one encrypted tunnel between the page's JavaScript and tabtopd
// (tunnel.go, tunnel_request.go), so a proxy that terminates TLS on the way sees
// neither logins nor content. With -base-path, all of it is served under
// that URL path instead of /, for a reverse proxy that puts the site in a
// subdirectory.
//
// Credentials are a TOTP code, or a password followed immediately by the
// code when a pam_oath PIN is set, checked against a pam_oath users file
// with liboath (see oath.go), which records used codes. One login buys a
// 12-hour session for the desktop, the terminal and the files.
//
// Failed logins are limited per client IP. Xvnc asks for no login of its
// own: it listens only on a socket that only the desktop user (and so the
// gateway) can open.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	filesPrefix   = "/fs/"
	maxFailures   = 5 // failed logins per client address (see limitKey) per failureWindow
	failureWindow = 5 * time.Minute
	// Failed logins per failureWindow, from every address together, past
	// which logins are checked at most one per siteThrottle (see loginTurn).
	maxSiteFailures = 30
	siteThrottle    = 5 * time.Second
	// Logins checked at once, from every address together.
	maxLoginWork = 4
	// Tunnels not yet logged in or tied to a session, from every address
	// together and from one, so connections that never finish their
	// handshake can't take everything.
	maxHandshakes      = 256
	maxHandshakesPerIP = 16 // per address (see limitKey)
	// Most entries a Downloads folder's listing shows.
	maxListing = 10000
	// Longest the search for unfinished uploads may hold up the start.
	staleUploadScan = 10 * time.Second
	// Most entries looked at for a listing, counting ones it leaves out.
	maxListingScan = 100000
	// Most proxy hops -trust-nproxies may trust.
	maxTrustNProxies = 10
	// Largest message accepted from a noVNC client; clipboard pastes are the
	// only big ones.
	maxClientMessage = 16 << 20
)

type server struct {
	serverConfig
	doctorProbes    doctorProbeCache
	vncBackoff      vncBackoff
	audio           *audioHub
	pingInterval    time.Duration // test override; zero uses the protocol default
	noble, ttyFiles assetSet
	highlight       assetSet
	preview         assetSet
	inpaint         assetSet // MI-GAN for browser inpainting
	background      assetSet // U2NetP and its browser runtime
	disasm          assetSet // iced-x86, for the hex view's disassembly
	pdfjs           assetSet
	pdfjsNames      []string // pdf.js's files, in pdfjsDir (see pdfjsFiles)
	handshakes      handshakes
	drain           tunnelDrain
	shares          *shareStore   // nil when share links are off
	fetches         *fetchManager // nil when fetching from URLs is off
	activity        *activityLog

	mu       sync.Mutex
	sessions map[string]*session // session id -> session
	ttys     map[string]int      // session token -> open terminals
	authentication
	clock     lifecycleClock
	transfers uploadManager
	seen      time.Time // when security warnings were last marked as seen

	placedMu sync.Mutex
	placedAt map[string]time.Time // names the gateway moved into ~/Downloads itself, lately (see watch.go)
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == markdownChildArg {
		os.Exit(renderMarkdownChild())
	}
	if len(os.Args) >= 2 && os.Args[1] == epubChildArg {
		os.Exit(renderEpubChild(os.Args[2:]))
	}
	if len(os.Args) >= 2 && os.Args[1] == sqliteChildArg {
		os.Exit(readSQLiteChild(os.Args[2:]))
	}
	c := defaultServerConfig()
	flag.BoolVar(&c.vncOff, "disable-vnc", false, "disable the desktop page and VNC tunnel")
	flag.BoolVar(&c.fsOff, "disable-fs", false, "disable file browsing, transfers, previews, share links and URL fetching")
	listen := flag.String("listen", ":6080", "address to serve on")
	basePath := flag.String("base-path", c.base, "URL path the site is served under, e.g. /tabtop/")
	flag.StringVar(&c.novncDir, "novnc-dir", c.novncDir, "noVNC client files")
	flag.StringVar(&c.vncAddr, "vnc-addr", c.vncAddr, "the RFB server's address, Xvnc's or another's: host:port, or unix:path for a socket")
	flag.BoolVar(&c.vncX509, "vnc-x509", c.vncX509, "require VeNCrypt with a verified certificate (X509Vnc, or X509Plain with -vnc-username) to log in to the VNC server")
	flag.StringVar(&c.vncUsername, "vnc-username", c.vncUsername, "username for the VNC server; selects X509Plain with -vnc-x509")
	flag.StringVar(&c.vncCAFile, "vnc-ca-file", c.vncCAFile, "PEM certificates to trust for -vnc-x509, instead of the system's")
	flag.StringVar(&c.vncServerName, "vnc-server-name", c.vncServerName, "name the VNC server's certificate must carry with -vnc-x509; defaults to -vnc-addr's host")
	flag.StringVar(&c.usersFile, "users-file", c.usersFile, "pam_oath users file holding the TOTP key")
	flag.StringVar(&c.vncPasswordFile, "vnc-password-file", c.vncPasswordFile,
		"file holding the password to give the VNC server, if it asks for one; empty or missing for noVNC to ask")
	flag.StringVar(&c.downloadsDir, "downloads-dir", c.downloadsDir, "directory served at "+filesPrefix)
	flag.IntVar(&c.trustNProxies, "trust-nproxies", c.trustNProxies,
		"how many proxies in front are trusted whatever their address, counting the one that connects")
	trusted := flag.String("trusted-proxies", "",
		"comma-separated IPs or CIDR ranges of reverse proxies whose X-Forwarded-For is believed; cloudflare stands for Cloudflare's published ranges")
	sessionMax := flag.String("session-max", c.sessionMax.String(), "how long a login lasts at most, in whole minutes, e.g. 12h")
	sessionIdle := flag.String("session-idle", c.sessionIdle.String(),
		"how long a login lasts with nothing open, in whole minutes, e.g. 1h; 0 for no limit")
	flag.StringVar(&c.termDir, "term-dir", c.termDir, "ghostty-web files for the terminal at "+ttyPrefix+"; empty turns it off")
	flag.StringVar(&c.ttyCommand, "tty-command", c.ttyCommand, "shell command each terminal runs instead of tmux, e.g. ssh -t host; empty for tmux")
	flag.BoolVar(&c.micCreate, "mic-create", c.micCreate,
		"make the microphone's devices (TabTop Mic) on the audio server, not as its default, and remove them on stopping; for a host's sound server")
	flag.StringVar(&c.micSink, "mic-sink", c.micSink, "PulseAudio sink browsers' microphones play into, for the desktop to record from its monitor; empty turns the microphone off")
	flag.StringVar(&c.audioSink, "audio-sink", c.audioSink, "PulseAudio sink whose sound is streamed to browsers; empty turns audio off")
	flag.BoolVar(&c.shareOn, "share", c.shareOn, "let logged-in pages make share links: plain URLs for files and folders, outside the encrypted tunnel")
	flag.StringVar(&c.sharesFile, "shares-file", c.sharesFile, "where share links are kept, to last across restarts; empty keeps them in memory")
	flag.StringVar(&c.shareKeyFile, "share-key-file", c.shareKeyFile, "the key share links' tokens are kept sealed with, to show them again; empty keeps one in memory")
	flag.StringVar(&c.activityFile, "activity-file", c.activityFile, "where the activity log is kept, to last across restarts; empty keeps it in memory")
	flag.BoolVar(&c.fetchOn, "fetch", c.fetchOn, "let logged-in pages have the gateway fetch a URL into ~/Downloads")
	flag.BoolVar(&c.fetchPrivate, "fetch-private", c.fetchPrivate, "let fetches reach private networks too, not only public addresses")
	flag.BoolVar(&c.previewFetchPrivate, "preview-fetch-private", c.previewFetchPrivate,
		"let previews in Proxy mode load a document's external resources from private networks too; the document picks those URLs")
	flag.BoolVar(&c.doctorOn, "doctor", c.doctorOn, "serve a troubleshooting report at doctor, without a login")
	flag.StringVar(&c.kaitaiDir, "kaitai-dir", c.kaitaiDir, "compiled Kaitai formats for binary previews; empty for none")
	flag.StringVar(&c.pdfjsDir, "pdfjs-dir", c.pdfjsDir, "pdf.js, for PDF previews; empty for none, and PDFs download instead")
	flag.StringVar(&c.inpaintDir, "inpaint-dir", c.inpaintDir, "MI-GAN model for image inpainting; empty for none")
	flag.StringVar(&c.backgroundDir, "background-dir", c.backgroundDir, "background removal model and browser runtime; empty for none")
	flag.StringVar(&c.disasmDir, "disasm-dir", c.disasmDir, "iced-x86, made loadable in a browser worker, for x86 disassembly in hex previews; empty for none")
	flag.StringVar(&c.previewDir, "preview-dir", c.previewDir, "KaTeX and Mermaid, for math and diagrams in Markdown previews; empty for none")
	flag.StringVar(&c.highlightDir, "highlight-dir", c.highlightDir, "highlight.js files for the colours of text previews; empty for none")
	flag.StringVar(&c.nobleDir, "noble-dir", c.nobleDir, "noble library files (ciphers/, curves/, hashes/) the tunnel's JavaScript needs")
	checkAddr := flag.String("check-vnc-addr", "", "only check an address as -vnc-addr takes it, and exit")
	flag.IntVar(&c.audioBitrate, "audio-bitrate", c.audioBitrate, fmt.Sprintf("audio bitrate in kbit/s (%d-%d)", minAudioBitrate, maxAudioBitrate))
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("tabtopd: ")
	if *checkAddr != "" {
		if err := checkVNCAddr(*checkAddr); err != nil {
			log.Fatal(err)
		}
		return
	}
	c.timeZone = pageTimeZone(os.Getenv("TZ"))
	var err error
	c.base = *basePath
	if c.trustedProxies, err = parsePrefixes(*trusted); err != nil {
		log.Fatalf("-trusted-proxies: %v", err)
	}
	if c.sessionMax, err = parseSessionLimit(*sessionMax, false); err != nil {
		log.Fatalf("-session-max: %v", err)
	}
	if c.sessionIdle, err = parseSessionLimit(*sessionIdle, true); err != nil {
		log.Fatalf("-session-idle: %v", err)
	}
	g, err := newServer(c)
	if err != nil {
		log.Fatal(err)
	}
	c = g.serverConfig
	if len(c.trustedProxies) > 0 {
		log.Printf("believing X-Forwarded-For from %s", strings.Join(describePrefixes(c.trustedProxies), ", "))
	}
	if c.trustNProxies > 0 {
		log.Printf("believing X-Forwarded-For from the %d nearest proxies, whatever their address", c.trustNProxies)
	}
	if g.fetches != nil && c.fetchPrivate {
		log.Print("fetching from URLs on, private networks included")
	}
	if g.fetches != nil && c.previewFetchPrivate {
		log.Print("previews' external resources may come from private networks")
	}
	if g.shares != nil {
		log.Printf("share links on: %d kept in %s", len(g.shares.list("")), c.sharesFile)
	}
	if c.doctorOn {
		log.Printf("serving the troubleshooting report at %s, without a login", g.abs("/doctor"))
	}
	if c.audioSink != "" {
		log.Printf("streaming audio from sink %s at %d kbit/s", c.audioSink, c.audioBitrate)
		if g.micSink != "" {
			log.Printf("playing browsers' microphones into sink %s", g.micSink)
		}
		if d := g.audio.devices; d != nil {
			// Now, so it can be picked in applications before anyone
			// turns it on; if the server isn't answering yet, then.
			go func() {
				if err := d.ensure(); err != nil {
					log.Printf("%s will be made when a browser turns it on: %v", micName, err)
				}
			}()
		}
	}

	srv := &http.Server{
		Addr:              *listen,
		Handler:           g.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    64 << 10, // requests are small; tunnels carry the rest
		IdleTimeout:       2 * time.Minute,
	}
	// Before serving, so no upload is going yet, whatever the file
	// system's timestamps.
	if !g.fsOff {
		removeStaleUploads(c.downloadsDir, time.Now(), staleUploadScan)
	}
	// Read the files browsers keep now, rather than on the first request.
	if tag, _ := g.noble.load(g.nobleAssets()); tag == "" {
		log.Printf("warning: can't read the noble files in %s; see /doctor", c.nobleDir)
	}
	if g.previewDir != "" {
		// Only checked: they're 7 MB, read when a Markdown preview first
		// asks for them.
		for _, name := range previewFiles {
			if _, err := os.Stat(filepath.Join(c.previewDir, name)); err != nil {
				log.Printf("warning: can't read KaTeX and Mermaid in %s; Markdown previews show math and diagrams as their source", c.previewDir)
				break
			}
		}
	}
	if g.highlightDir != "" {
		if tag, _ := g.highlight.load(g.highlightAssets()); tag == "" {
			log.Printf("warning: can't read the highlight.js files in %s; text previews have no colours", c.highlightDir)
		}
	}
	if g.termDir != "" {
		if tag, _ := g.ttyFiles.load(g.termAssets()); tag == "" {
			log.Printf("warning: can't read the terminal's files in %s; see /doctor", g.termDir)
		}
	}
	log.Printf("listening on %s under %s; desktop=%t terminal=%t files=%t", *listen, g.base, !g.vncOff, g.termDir != "", !g.fsOff)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	served := make(chan error, 1)
	go func() { served <- srv.ListenAndServe() }()
	select {
	case err := <-served:
		log.Fatal(err)
	case <-ctx.Done():
	}
	stop() // a second signal kills at once
	log.Print("stopping: closing connections")
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	// Shutdown stops listening and waits for requests going on; the
	// tunnels, which it can't see, the gateway closes itself.
	var wg sync.WaitGroup
	wg.Go(func() { srv.Shutdown(ctx) })
	if err := g.shutdown(ctx); err != nil {
		log.Printf("stopping: some connections didn't close in %s", shutdownGrace)
	}
	wg.Wait()
	log.Print("stopped")
}

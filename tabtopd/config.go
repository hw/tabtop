package main

import (
	"fmt"
	"log"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"slices"
	"time"
)

// serverConfig contains settings fixed before serving. Runtime services and
// mutable state belong to server, rather than the flag parser.
type serverConfig struct {
	remoteApprovalURL string
	vncOff, fsOff     bool
	// offlineClient lets the offline client (bootstrap's tabtop.html, opened
	// as a file, its origin "null") open the tunnel; see tunnelWS.
	offlineClient                         bool
	base                                  string
	novncDir                              string
	vncAddr                               string
	usersFile                             string
	vncPasswordFile                       string
	vncX509                               bool
	vncCAFile, vncServerName, vncUsername string
	downloadsDir                          string
	fsRoots, fsHome                       string
	trustedProxies                        []netip.Prefix
	trustNProxies                         int
	termDir, ttyCommand                   string
	ttyTmuxHost, ttyTmuxSession           string
	doctorOn                              bool
	nobleDir, timeZone                    string
	highlightDir                          string // highlight.js, for text previews' colours; "" for none
	previewDir                            string // KaTeX and Mermaid, for Markdown previews; "" for none
	kaitaiDir                             string // compiled Kaitai formats; "" for none
	pdfjsDir                              string // pdf.js, for PDF previews; "" for none
	inpaintDir                            string // MI-GAN ONNX model for image repairs; "" for none
	backgroundDir                         string // ONNX Runtime Web and U2NetP for image background removal; "" for none
	segmentDir                            string // MobileSAM ONNX models, for magic select in image editing; "" for none
	threeDir                              string // three.js, for 3D previews of models and G-code; "" for none
	disasmDir                             string // iced-x86 for the browser, for disassembly in hex previews; "" for none
	disasmOff                             string // the disassemblers turned off: "none", "all", or of x86, arm64, capstone, riscv and mips (see disasmDisabled)
	sessionMax, sessionIdle               time.Duration
	audioSink, micSink                    string
	micCreate                             bool   // make micSink and its source on the audio server
	shareOn                               bool   // share links
	sharesFile                            string // where they're kept; "" for in memory
	fetchOn, fetchPrivate                 bool   // fetching from URLs, and from private networks
	previewFetchPrivate                   bool   // previews' external resources from private networks too
	goOn                                  bool   // the remote browser, /go
	goEngine                              string // its page engine's binary (Moli or Obscura: goAdapterFor); "" for none
	goUnsandboxed                         bool   // run the engine even where it can't be sandboxed
	goPrivate                             bool   // let the remote browser reach private networks too
	goCache                               bool   // the engines share an HTTP cache on disk (gocache.go)
	activityFile                          string // where the activity log is kept; "" for in memory
	passkeysFile                          string // where passkeys are kept; "" for in memory
	goCookiesFile                         string // the remote browser's cookies, sealed; "" for in memory
	goCookiesKeyFile                      string // what they're sealed with
	goStorageFile                         string // its sites' localStorage, sealed likewise; "" for in memory
	goSitesFile                           string // its site settings; "" for in memory
	goAdBlockFile                         string // its ad blocking settings, the lists beside it; "" for in memory
	shareKeyFile                          string // what share links' tokens are sealed with; "" for a key in memory
	audioBitrate                          int
}

func defaultServerConfig() serverConfig {
	return serverConfig{base: "/", novncDir: "/opt/novnc", vncAddr: "127.0.0.1:5901", sessionMax: defaultSessionMax, sessionIdle: defaultSessionIdle, timeZone: "UTC", audioBitrate: 64}
}

func newServer(c serverConfig) (*server, error) {
	if err := validateRemoteTTY(&c); err != nil {
		return nil, err
	}
	if c.remoteApprovalURL != "" && !validApprovalURL(c.remoteApprovalURL) {
		return nil, fmt.Errorf("-remote-approval-url must be an HTTPS URL without credentials, query or fragment (HTTP is allowed only on localhost)")
	}
	if c.usersFile == "" || !c.fsOff && c.downloadsDir == "" && c.fsRoots == "" || c.nobleDir == "" {
		return nil, fmt.Errorf("-users-file and -noble-dir are required, and -downloads-dir or -fs-roots (WEB_FS_ROOTS) unless files are off")
	}
	if c.vncOff && c.fsOff && c.termDir == "" && !c.goOn {
		return nil, fmt.Errorf("enable at least one of VNC, terminal, files or the remote browser")
	}
	fetchOn := c.fetchOn // before files being off turns it off
	if c.fsOff {
		c.shareOn, c.fetchOn = false, false
	}
	if c.vncOff {
		c.audioSink, c.micSink, c.micCreate = "", "", false
	}
	base, err := parseBasePath(c.base)
	if err != nil {
		return nil, fmt.Errorf("-base-path: %w", err)
	}
	c.base = base
	if err := checkVNCAddr(c.vncAddr); !c.vncOff && err != nil {
		return nil, fmt.Errorf("-vnc-addr: %w", err)
	}
	if !c.vncOff && c.vncUsername != "" && !c.vncX509 {
		return nil, fmt.Errorf("-vnc-username requires -vnc-x509")
	}
	if c.trustNProxies < 0 || c.trustNProxies > maxTrustNProxies {
		return nil, fmt.Errorf("-trust-nproxies must be 0 to %d", maxTrustNProxies)
	}
	if c.sessionMax <= 0 || c.sessionMax%time.Minute != 0 {
		return nil, fmt.Errorf("-session-max: %w", errBadLimit)
	}
	if c.sessionIdle < 0 || c.sessionIdle%time.Minute != 0 {
		return nil, fmt.Errorf("-session-idle: %w", errBadLimit)
	}
	if c.micCreate {
		if c.micSink != "" {
			return nil, fmt.Errorf("-mic-create makes its own sink, so takes no -mic-sink")
		}
		c.micSink = micSinkName
	}
	if c.micSink != "" && c.audioSink == "" {
		return nil, fmt.Errorf("-mic-sink and -mic-create require -audio-sink")
	}
	if c.audioSink != "" && (c.audioBitrate < minAudioBitrate || c.audioBitrate > maxAudioBitrate) {
		return nil, fmt.Errorf("-audio-bitrate must be %d to %d", minAudioBitrate, maxAudioBitrate)
	}
	c.trustedProxies = slices.Clone(c.trustedProxies)
	g := &server{serverConfig: c, authentication: authentication{failures: map[string][]time.Time{}, pending: map[string]int{}}, sessions: map[string]*session{}, ttys: map[string]int{}}
	g.activity = newActivityLog(c.activityFile, g.clock)
	if !c.fsOff {
		g.roots, g.rootProblems, err = parseFileRootsAll(c.fsRoots, c.fsHome, c.downloadsDir)
		if err != nil {
			return nil, err
		}
		// Not a root holding the gateway's own files (the login's key,
		// passkeys, the share links' key...): through it they'd be read,
		// by whoever a folder above them is shared with, and written, by
		// whoever has a session, which would then be a login for good.
		state := []string{c.usersFile, c.vncPasswordFile, c.sharesFile, c.shareKeyFile, c.activityFile, c.passkeysFile, c.goCookiesFile, c.goCookiesKeyFile, c.goStorageFile, c.goSitesFile, c.goAdBlockFile}
		g.roots = slices.DeleteFunc(g.roots, func(root *fileRoot) bool {
			dir := root.Path
			if dir == "" {
				dir = c.downloadsDir
			}
			held := stateFileIn(dir, state)
			if held == "" {
				return false
			}
			g.rootProblems = append(g.rootProblems, rootProblem{root.ID, root.Label,
				fmt.Errorf("it holds TabTop's own files (%s), which Files mustn't reach: expose the folders wanted beside them, not one they're in", held)})
			return true
		})
		for _, p := range g.rootProblems {
			log.Printf("warning: root %q is unavailable and left out until a restart: %v", p.Label, p.Err)
		}
	}
	g.passkeys = newPasskeyStore(c.passkeysFile)
	if c.pdfjsDir != "" {
		g.pdfjsNames = pdfjsFiles(c.pdfjsDir)
	}
	if c.shareOn {
		g.shares = newShareStore(c.sharesFile, g.clock)
		if c.shareKeyFile != "" {
			g.shares.key = loadShareKey(c.shareKeyFile)
		}
	}
	if c.fetchOn {
		// Previews' external resources, for every root; fetches, only
		// into the roots that can be written to.
		g.resourceClient = newFetchClient(fetchPolicy(c.previewFetchPrivate))
		client := newFetchClient(fetchPolicy(c.fetchPrivate))
		var goClient *http.Client
		if c.goOn {
			goClient = newFetchClient(fetchPolicy(c.fetchPrivate && c.goPrivate))
		}
		slots := make(chan struct{}, maxFetches) // across the roots
		for _, root := range g.roots {
			if !root.ReadOnly {
				root.fetches = &fetchManager{files: g.scope(root), activity: g.activity, client: client, goClient: goClient, slots: slots}
			}
		}
	}
	if c.goOn {
		// The remote browser doesn't need files, but WEB_GO_FETCH=0 (no
		// fetching from URLs at all) turns it off too. Said in the log
		// (main), not silently.
		g.goMode = goUnavailable
		if !fetchOn {
			g.goWhy = "fetching from URLs is off (WEB_GO_FETCH=0)"
		} else if c.goEngine == "" {
			g.goWhy = "no engine is set (-go-engine, WEB_GO_ENGINE)"
		} else if fi, err := os.Stat(c.goEngine); err != nil || fi.IsDir() || fi.Mode()&0o111 == 0 {
			g.goWhy = fmt.Sprintf("its engine, %s, isn't an executable file", c.goEngine)
		} else {
			bwrap, _ := exec.LookPath("bwrap")
			g.goMode, g.goWhy = goSandboxProbe(bwrap, c.goUnsandboxed)
			g.goConfig = goEngineConfig{engine: c.goEngine, mode: g.goMode, bwrap: bwrap, allow: fetchPolicy(c.goPrivate)}
			if c.goCache && g.goMode != goUnavailable {
				g.goConfig.cache = goCacheDir()
				goPruneCacheSoon(g.goConfig.cache)
			}
			if g.goMode != goUnavailable {
				g.goCookies = newGoCookieJar(c.goCookiesFile, c.goCookiesKeyFile)
				if goAdapterFor(c.goEngine).name == "Moli" {
					key := g.goCookies.key
					if key == nil && c.goStorageFile != "" && c.goCookiesKeyFile != "" {
						key = loadKeyFile(c.goCookiesKeyFile, "go: storage")
					}
					g.goStorage = newGoStorage(c.goStorageFile, key)
				}
				g.goSites = newGoSiteSettings(c.goSitesFile)
				goBlockedHost = g.goSites.isBlocked
				g.goAds = newGoAdBlock(c.goAdBlockFile, fetchPolicy(c.goPrivate))
				g.goAds.siteBlocks = g.goSites.adsBlocked
				ads, sites := g.goAds, g.goSites
				goAdBlocked = func(host, page string) bool { return ads.blocked(host, page, sites.adsFor(page)) }
				goAdHideRules = func(page string) *goAdRules { return ads.hideRules(sites.adsFor(page)) }
				goAdBlockedURL = func(raw string, t uint16, page string) (bool, bool) {
					return ads.blockedURL(raw, t, page, sites.adsFor(page))
				}
				go g.goAds.run()
				g.goResources = newGoResourceClient(fetchPolicy(c.goPrivate))
				sweepGoRunDirs()
			}
		}
	}
	if g.shares != nil {
		// Links to a root only missing for now (an unmounted drive) are
		// kept: they work again once it's back and TabTop restarts.
		g.shares.revoke(func(l *shareLink) bool {
			if slices.ContainsFunc(g.rootProblems, func(p rootProblem) bool { return p.ID == l.Root }) {
				return false
			}
			_, err := g.filesForShare(l)
			return err != nil
		})
	}
	if c.audioSink != "" {
		var devices *micDevices
		if c.micCreate {
			devices = &micDevices{}
		}
		g.audio = newAudioHub(c.audioSink, c.micSink, c.audioBitrate, devices)
	}
	g.startBootstrapRotation()
	return g, nil
}

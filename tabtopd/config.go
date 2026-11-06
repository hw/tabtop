package main

import (
	"fmt"
	"net/netip"
	"slices"
	"time"
)

// serverConfig contains settings fixed before serving. Runtime services and
// mutable state belong to server, rather than the flag parser.
type serverConfig struct {
	vncOff, fsOff                         bool
	base                                  string
	novncDir                              string
	vncAddr                               string
	usersFile                             string
	vncPasswordFile                       string
	vncX509                               bool
	vncCAFile, vncServerName, vncUsername string
	downloadsDir                          string
	trustedProxies                        []netip.Prefix
	trustNProxies                         int
	termDir, ttyCommand                   string
	doctorOn                              bool
	nobleDir, timeZone                    string
	highlightDir                          string // highlight.js, for text previews' colours; "" for none
	previewDir                            string // KaTeX and Mermaid, for Markdown previews; "" for none
	kaitaiDir                             string // compiled Kaitai formats; "" for none
	pdfjsDir                              string // pdf.js, for PDF previews; "" for none
	sessionMax, sessionIdle               time.Duration
	audioSink, micSink                    string
	micCreate                             bool   // make micSink and its source on the audio server
	shareOn                               bool   // share links
	sharesFile                            string // where they're kept; "" for in memory
	fetchOn, fetchPrivate                 bool   // fetching from URLs, and from private networks
	activityFile                          string // where the activity log is kept; "" for in memory
	shareKeyFile                          string // what share links' tokens are sealed with; "" for a key in memory
	audioBitrate                          int
}

func defaultServerConfig() serverConfig {
	return serverConfig{base: "/", novncDir: "/opt/novnc", vncAddr: "127.0.0.1:5901", sessionMax: defaultSessionMax, sessionIdle: defaultSessionIdle, timeZone: "UTC", audioBitrate: 64}
}

func newServer(c serverConfig) (*server, error) {
	if c.usersFile == "" || !c.fsOff && c.downloadsDir == "" || c.nobleDir == "" {
		return nil, fmt.Errorf("-users-file, -downloads-dir and -noble-dir are required")
	}
	if c.vncOff && c.fsOff && c.termDir == "" {
		return nil, fmt.Errorf("enable at least one of VNC, terminal or files")
	}
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
		private := c.fetchPrivate
		g.fetches = &fetchManager{downloadsDir: c.downloadsDir, transfers: &g.transfers, activity: g.activity,
			client: newFetchClient(fetchPolicy(private))}
	}
	if c.audioSink != "" {
		var devices *micDevices
		if c.micCreate {
			devices = &micDevices{}
		}
		g.audio = newAudioHub(c.audioSink, c.micSink, c.audioBitrate, devices)
	}
	return g, nil
}

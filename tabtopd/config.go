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
	sessionMax, sessionIdle               time.Duration
	audioSink                             string
	audioBitrate                          int
}

func defaultServerConfig() serverConfig {
	return serverConfig{base: "/", novncDir: "/opt/novnc", vncAddr: "127.0.0.1:5901", sessionMax: defaultSessionMax, sessionIdle: defaultSessionIdle, timeZone: "UTC", audioBitrate: 64}
}

func newServer(c serverConfig) (*server, error) {
	if c.usersFile == "" || c.downloadsDir == "" || c.nobleDir == "" {
		return nil, fmt.Errorf("-users-file, -downloads-dir and -noble-dir are required")
	}
	base, err := parseBasePath(c.base)
	if err != nil {
		return nil, fmt.Errorf("-base-path: %w", err)
	}
	c.base = base
	if err := checkVNCAddr(c.vncAddr); err != nil {
		return nil, fmt.Errorf("-vnc-addr: %w", err)
	}
	if c.vncUsername != "" && !c.vncX509 {
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
	if c.audioSink != "" && (c.audioBitrate < minAudioBitrate || c.audioBitrate > maxAudioBitrate) {
		return nil, fmt.Errorf("-audio-bitrate must be %d to %d", minAudioBitrate, maxAudioBitrate)
	}
	c.trustedProxies = slices.Clone(c.trustedProxies)
	g := &server{serverConfig: c, authentication: authentication{failures: map[string][]time.Time{}, pending: map[string]int{}}, sessions: map[string]*session{}, ttys: map[string]int{}}
	if c.audioSink != "" {
		g.audio = newAudioHub(c.audioSink, c.audioBitrate)
	}
	return g, nil
}

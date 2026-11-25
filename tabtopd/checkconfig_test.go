package main

import (
	"strings"
	"testing"
)

// TestCheckSettings: -check-config's checks, without the paths the
// container sets up later, say a wrong setting by its variable's name.
func TestCheckSettings(t *testing.T) {
	c := defaultServerConfig()
	if err := checkSettings(c); err != nil {
		t.Fatalf("the defaults: %v", err)
	}
	for name, change := range map[string]func(*serverConfig){
		"WEB_BASE_PATH":           func(c *serverConfig) { c.base = "/a/../b" },
		"WEB_REMOTE_APPROVAL_URL": func(c *serverConfig) { c.remoteApprovalURL = "http://x.example" },
		"WEB_AUDIO_BITRATE":       func(c *serverConfig) { c.audioBitrate = 999 },
		"WEB_TRUST_NPROXIES":      func(c *serverConfig) { c.trustNProxies = 11 },
		"VNC_ADDR":                func(c *serverConfig) { c.vncAddr = "bad::addr" },
		"WEB_TTY_TMUX_HOST":       func(c *serverConfig) { c.ttyTmuxHost = "-oProxyCommand=x" },
	} {
		c := defaultServerConfig()
		change(&c)
		err := checkSettings(c)
		if err == nil {
			t.Errorf("%s: a wrong one passed", name)
			continue
		}
		if said := settingNames.Replace(err.Error()); !strings.Contains(said, name) {
			t.Errorf("%s: said as %q", name, said)
		}
	}
	// The terminal alone (its files given only at the start): checked.
	c = defaultServerConfig()
	c.vncOff, c.fsOff = true, true
	if err := checkSettings(c); err != nil {
		t.Errorf("the terminal alone: %v", err)
	}
	// No desktop: its address and sound aren't checked.
	c = defaultServerConfig()
	c.vncOff, c.vncAddr, c.audioBitrate = true, "bad::addr", 999
	if err := checkSettings(c); err != nil {
		t.Errorf("without a desktop: %v", err)
	}
}

package main

import (
	"net/netip"
	"testing"
	"time"
)

func validTestConfig() serverConfig {
	c := defaultServerConfig()
	c.usersFile, c.downloadsDir, c.nobleDir = "users.oath", "downloads", "noble"
	return c
}

func TestNewServerInitializesRuntime(t *testing.T) {
	c := validTestConfig()
	c.base = "nested/site"
	c.trustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	g, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if g.base != "/nested/site/" || g.sessionMax != defaultSessionMax || g.sessionIdle != defaultSessionIdle {
		t.Fatal("defaults or base normalization lost")
	}
	if g.sessions == nil || g.ttys == nil || g.failures == nil || g.pending == nil {
		t.Fatal("runtime maps not initialized")
	}
	c.trustedProxies[0] = netip.MustParsePrefix("192.0.2.0/24")
	if g.trustedProxies[0] == c.trustedProxies[0] {
		t.Fatal("server retained mutable configuration slice")
	}
	c = validTestConfig()
	c.sessionIdle = 0
	c.audioSink = "test-sink"
	g, err = newServer(c)
	if err != nil || g.sessionIdle != 0 || g.audio == nil {
		t.Fatalf("explicit configuration lost: %v", err)
	}
}

// -mic-create plays into the sink it makes, and the hub knows to make it.
func TestNewServerMicCreate(t *testing.T) {
	c := validTestConfig()
	c.audioSink, c.micCreate = "sink", true
	g, err := newServer(c)
	if err != nil {
		t.Fatal(err)
	}
	if g.micSink != micSinkName || g.audio.devices == nil || g.audio.play == nil {
		t.Fatalf("mic sink %q, devices %v", g.micSink, g.audio.devices)
	}
	c.micCreate, c.micSink = false, "mic"
	if g, err = newServer(c); err != nil || g.audio.devices != nil || g.audio.play == nil {
		t.Fatalf("a given mic sink: %v, devices %v", err, g.audio.devices)
	}
}

func TestNewServerRejectsInvalidConfiguration(t *testing.T) {
	for name, change := range map[string]func(*serverConfig){
		"missing users":           func(c *serverConfig) { c.usersFile = "" },
		"missing downloads":       func(c *serverConfig) { c.downloadsDir = "" },
		"missing libraries":       func(c *serverConfig) { c.nobleDir = "" },
		"invalid base":            func(c *serverConfig) { c.base = "/../" },
		"invalid upstream":        func(c *serverConfig) { c.vncAddr = "missing-port" },
		"username without TLS":    func(c *serverConfig) { c.vncUsername = "alice" },
		"too many trusted hops":   func(c *serverConfig) { c.trustNProxies = maxTrustNProxies + 1 },
		"zero max lifetime":       func(c *serverConfig) { c.sessionMax = 0 },
		"fractional max lifetime": func(c *serverConfig) { c.sessionMax = time.Second },
		"negative idle":           func(c *serverConfig) { c.sessionIdle = -time.Minute },
		"invalid audio":           func(c *serverConfig) { c.audioSink = "sink"; c.audioBitrate = 1 },
		"mic without audio":       func(c *serverConfig) { c.micSink = "mic" },
		"made mic without audio":  func(c *serverConfig) { c.micCreate = true },
		"made mic and a sink":     func(c *serverConfig) { c.audioSink = "sink"; c.micSink = "mic"; c.micCreate = true },
	} {
		t.Run(name, func(t *testing.T) {
			c := validTestConfig()
			change(&c)
			if _, err := newServer(c); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

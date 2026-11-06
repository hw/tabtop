package main

// When tabtopd was built, for Sessions and Activity. Set at link time
// (-X main.buildTime=…, as the Dockerfile and mise build do); otherwise
// taken from the binary's modification time.

import (
	"os"
	"runtime/debug"
	"strings"
	"time"
)

// buildTime is when this binary was built, as UTC RFC3339, or empty until
// resolved (see tabtopBuildTime).
var buildTime string

// tabtopBuildTime is when this tabtopd was built, as UTC RFC3339, or "".
func tabtopBuildTime() string {
	if t := strings.TrimSpace(buildTime); t != "" {
		return t
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			if s.Key == "vcs.time" && s.Value != "" {
				if parsed, err := time.Parse(time.RFC3339, s.Value); err == nil {
					buildTime = parsed.UTC().Format(time.RFC3339)
					return buildTime
				}
				buildTime = s.Value
				return buildTime
			}
		}
	}
	if exe, err := os.Executable(); err == nil {
		if st, err := os.Stat(exe); err == nil {
			buildTime = st.ModTime().UTC().Format(time.RFC3339)
			return buildTime
		}
	}
	return ""
}

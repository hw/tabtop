package main

// -check-config: the container's settings (WEB_ and VNC_ variables, as
// startup/config.sh passes them) checked by tabtopd's own rules before
// anything is set up, so a wrong one stops the start at once, said by its
// name, rather than after the desktop's started, said as a flag.

import (
	"io"
	"log"
	"strings"
)

// settingNames are the flags the container sets from its variables, by
// the variable's name.
var settingNames = strings.NewReplacer(
	"-base-path", "WEB_BASE_PATH",
	"-trusted-proxies", "WEB_TRUSTED_PROXIES",
	"-trust-nproxies", "WEB_TRUST_NPROXIES",
	"-hosts", "WEB_HOSTS",
	"-session-max", "WEB_SESSION_MAX",
	"-session-idle", "WEB_SESSION_IDLE",
	"-remote-approval-url", "WEB_REMOTE_APPROVAL_URL",
	"-audio-bitrate", "WEB_AUDIO_BITRATE",
	"-disasm-disable", "WEB_DISASM_DISABLE",
	"-tty-command", "WEB_TTY_COMMAND",
	"-tty-tmux-host", "WEB_TTY_TMUX_HOST",
	"-tty-tmux-session", "WEB_TTY_TMUX_SESSION",
	"-vnc-addr", "VNC_ADDR",
	"-vnc-username", "VNC_UPSTREAM_USERNAME",
	"-fs-roots", "WEB_FS_ROOTS",
)

// settingsWriter writes what's logged with flags said as the variables
// they come from.
type settingsWriter struct{ w io.Writer }

func (s settingsWriter) Write(p []byte) (int, error) {
	if _, err := io.WriteString(s.w, settingNames.Replace(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// checkConfig checks c (its flags read) as newServer would
// (checkSettings), and exits: 1, with why, if a setting is wrong.
func checkConfig(c serverConfig) {
	if err := checkSettings(c); err != nil {
		log.Fatal(err)
	}
}

// checkSettings is c.check, with stand-ins for what the container sets up
// after this: the users file, the libraries' folders, Downloads, the
// terminal's files, the desktop's address and its sound.
func checkSettings(c serverConfig) error {
	// (Which of the desktop, terminal and files are on is config.sh's to
	// check, before: the terminal's files are only given at the start.)
	for _, p := range []*string{&c.usersFile, &c.nobleDir, &c.downloadsDir, &c.termDir} {
		if *p == "" {
			*p = "/nonexistent"
		}
	}
	if c.vncAddr == "" {
		c.vncAddr = "127.0.0.1:5901"
	}
	if c.audioSink == "" {
		c.audioSink = "check" // (so WEB_AUDIO_BITRATE is checked whatever the sound)
	}
	return c.check()
}

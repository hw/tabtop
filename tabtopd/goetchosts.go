package main

// Where the remote browser (/go) finds a name, in order (goDialer):
//
//  1. its own local DNS records (gohosts.go; Settings);
//  2. this machine's /etc/hosts (a container's --add-host lines among them);
//  3. DNS over HTTPS while it's on (godoh.go), else the system's DNS.
//
// Whatever's found goes by the address policy as any other address.

import (
	"bytes"
	"io"
	"log"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

var goEtcHostsFile = "/etc/hosts" // (tests change it)

const (
	goEtcHostsEvery = 5 * time.Second // the least time between looks at the file
	goEtcHostsMax   = 16 << 20        // its bytes, read (a blocklist's can be a few MB)
)

var goEtcHosts struct {
	sync.Mutex
	file    string
	checked time.Time
	mod     time.Time
	size    int64
	names   map[string][]netip.Addr
}

// goEtcHostsLookup is name's addresses in /etc/hosts, if it's there (the
// file read again once it's changed, looked at every few seconds at most;
// read and parsed with the lock let go: dials meanwhile use what was had).
func goEtcHostsLookup(name string) ([]netip.Addr, bool) {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	h := &goEtcHosts
	h.Lock()
	file := goEtcHostsFile
	if h.file != file || time.Since(h.checked) >= goEtcHostsEvery {
		h.checked = time.Now()
		if fi, err := os.Stat(file); err != nil {
			h.file, h.names, h.mod, h.size = file, nil, time.Time{}, 0
		} else if h.file != file || !fi.ModTime().Equal(h.mod) || fi.Size() != h.size {
			first := h.names == nil || h.file != file
			h.file, h.mod, h.size = file, fi.ModTime(), fi.Size()
			if first {
				// Nothing of it had yet: read with the lock held, so a dial
				// meanwhile waits for it rather than finding nothing.
				h.names = goReadEtcHosts(file)
			} else {
				h.Unlock()
				names := goReadEtcHosts(file)
				h.Lock()
				if h.file == file && h.mod.Equal(fi.ModTime()) {
					h.names = names
				}
			}
		}
	}
	addrs, ok := h.names[name]
	h.Unlock()
	return addrs, ok
}

// goReadEtcHosts is a hosts file's names (lower case) and their addresses.
func goReadEtcHosts(file string) map[string][]netip.Addr {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	data, _ := io.ReadAll(io.LimitReader(f, goEtcHostsMax+1))
	if len(data) > goEtcHostsMax {
		// Past what's read: the line it's cut in isn't one (its name cut).
		data = data[:bytes.LastIndexByte(data[:goEtcHostsMax], '\n')+1]
		log.Printf("go: %s is over %d MB: only its first lines are used", file, goEtcHostsMax>>20)
	}
	names := map[string][]netip.Addr{}
	// (Line by line, however long: a blocklist's line of thousands of
	// names isn't the end of the file.)
	for raw := range bytes.Lines(data) {
		line, _, _ := strings.Cut(string(raw), "#")
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		a, err := netip.ParseAddr(fields[0])
		if err != nil || a.Zone() != "" {
			continue // (an address with a zone: of one interface only)
		}
		a = a.Unmap()
		for _, name := range fields[1:] {
			if name = goHostName(name); name != "" && !slices.Contains(names[name], a) {
				names[name] = append(names[name], a)
			}
		}
	}
	return names
}

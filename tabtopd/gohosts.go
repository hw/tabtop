package main

// Local DNS records for the remote browser (/go; Settings: Local DNS
// records): names the person gives addresses for (A and AAAA), looked up
// there first, before DNS over HTTPS or the system's DNS, wherever the
// browser dials (goDialer: the engine's tunnels, what this server fetches
// for its pages, its downloads, its filter lists) and for a custom DoH
// server's own name. A name listed is only ever at the addresses listed
// for it: not looked up anywhere else, even if none of them answers.
// Their addresses go by the address policy as any other's: a private
// network's only with WEB_GO_PRIVATE, never this machine's.

import (
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"weak"
)

// goHostRecord is one local record: a name and one of its addresses.
type goHostRecord struct {
	Name string `json:"name"`
	Addr string `json:"addr"`
}

const maxGoHostRecords = 256

// goHostsNow is the local records in use, by name (nil: none).
var goHostsNow atomic.Pointer[map[string][]netip.Addr]

// goHostName is a record's name as it's kept: lower case, without a final
// dot; "" if it isn't a host name (an address isn't one).
func goHostName(raw string) string {
	h := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
	if h == "" || len(h) > 253 {
		return ""
	}
	if _, err := netip.ParseAddr(strings.Trim(h, "[]")); err == nil {
		return ""
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return ""
		}
		for _, r := range label {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
				return ""
			}
		}
	}
	return h
}

// goHostRecords checks records given (Settings) and puts them as they're
// kept: each name's, an address once, in the order given.
func goHostRecords(in []goHostRecord) ([]goHostRecord, error) {
	if len(in) > maxGoHostRecords {
		return nil, fmt.Errorf("At most %d local records.", maxGoHostRecords)
	}
	out := make([]goHostRecord, 0, len(in))
	for _, r := range in {
		name := goHostName(r.Name)
		if name == "" {
			return nil, fmt.Errorf("%q isn't a host name.", strings.TrimSpace(r.Name))
		}
		a, err := netip.ParseAddr(strings.Trim(strings.TrimSpace(r.Addr), "[]"))
		if err != nil || a.Zone() != "" {
			return nil, fmt.Errorf("%q isn't an IPv4 or IPv6 address.", strings.TrimSpace(r.Addr))
		}
		a = a.Unmap()
		if a.IsUnspecified() {
			return nil, errors.New("An address of all zeros isn't one that can be reached.")
		}
		rec := goHostRecord{Name: name, Addr: a.String()}
		if !slices.Contains(out, rec) {
			out = append(out, rec)
		}
	}
	return out, nil
}

// goHostsTable is records by name (nil for none).
func goHostsTable(records []goHostRecord) *map[string][]netip.Addr {
	if len(records) == 0 {
		return nil
	}
	m := map[string][]netip.Addr{}
	for _, r := range records {
		if a, err := netip.ParseAddr(r.Addr); err == nil {
			m[r.Name] = append(m[r.Name], a)
		}
	}
	return &m
}

// goDNSTransports are the transports that dial by goDialer (the engines'
// proxies', the browser's own fetches'), held weakly (a proxy goes with
// its engine).
var goDNSTransports struct {
	sync.Mutex
	list []weak.Pointer[http.Transport]
}

// goDNSTransport notes t as one that dials by goDialer; it's returned.
func goDNSTransport(t *http.Transport) *http.Transport {
	goDNSTransports.Lock()
	defer goDNSTransports.Unlock()
	goDNSTransports.list = slices.DeleteFunc(goDNSTransports.list, func(w weak.Pointer[http.Transport]) bool { return w.Value() == nil })
	goDNSTransports.list = append(goDNSTransports.list, weak.Make(t))
	return t
}

// goDNSChanged is where names are changed (local records, DNS over
// HTTPS): connections kept idle let go, so what's asked next is dialled
// where the names are now. (Tunnels open go on till they close.)
func goDNSChanged() {
	goDNSTransports.Lock()
	defer goDNSTransports.Unlock()
	for _, w := range goDNSTransports.list {
		if t := w.Value(); t != nil {
			t.CloseIdleConnections()
		}
	}
}

// goHostsLookup is name's local addresses, if it has a record.
func goHostsLookup(name string) ([]netip.Addr, bool) {
	m := goHostsNow.Load()
	if m == nil {
		return nil, false
	}
	addrs, ok := (*m)[strings.TrimSuffix(strings.ToLower(name), ".")]
	return addrs, ok
}

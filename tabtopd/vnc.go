package main

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// dialVNC connects to the RFB server, over TCP or (with "unix:") a socket.
func (g *server) dialVNC() (net.Conn, error) {
	return g.dialVNCWithin(5 * time.Second)
}

func (g *server) dialVNCWithin(timeout time.Duration) (net.Conn, error) {
	if path, ok := strings.CutPrefix(g.vncAddr, "unix:"); ok {
		return net.DialTimeout("unix", path, timeout)
	}
	return net.DialTimeout("tcp", g.vncAddr, timeout)
}

// checkVNCAddr checks an RFB server's address: host:port, with a port from
// 1 to 65535 and an IPv6 address in brackets, or unix: and an absolute path.
func checkVNCAddr(addr string) error {
	if path, ok := strings.CutPrefix(addr, "unix:"); ok {
		if !strings.HasPrefix(path, "/") || path == "/" {
			return fmt.Errorf("%q: a socket needs an absolute path, as unix:/run/vnc.sock", addr)
		}
		return nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("%q: want host:port, [IPv6]:port or unix:/path", addr)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("%q: the port must be 1 to 65535", addr)
	}
	if host == "" || strings.ContainsAny(host, " /") {
		return fmt.Errorf("%q: the host is missing or malformed", addr)
	}
	return nil
}

package main

import (
	"context"
	"net"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

// The bridge makes a real HTTP/1.1 WebSocket upgrade over an in-memory
// connection. ConnContext carries the public request directly to the tunnel
// handler, without putting client metadata or a new listener on the network.
type pollUpstream struct {
	mu       sync.Mutex
	server   *http.Server
	listener *pollPipeListener
	stopped  bool
}

type pollPipeConn struct {
	net.Conn
	original *http.Request
}

type pollRequestKey struct{}

type pollPipeListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func (l *pollPipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *pollPipeListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (*pollPipeListener) Addr() net.Addr {
	return &net.UnixAddr{Name: "tabtop-poll", Net: "pipe"}
}

func (u *pollUpstream) dial(ctx context.Context, g *server, r *http.Request) (*websocket.Conn, *http.Response, error) {
	u.mu.Lock()
	if u.stopped {
		u.mu.Unlock()
		return nil, nil, context.Canceled
	}
	if u.server == nil {
		l := &pollPipeListener{conns: make(chan net.Conn), done: make(chan struct{})}
		srv := &http.Server{
			ReadHeaderTimeout: handshakeTimeout,
			MaxHeaderBytes:    4096,
			ConnContext: func(ctx context.Context, c net.Conn) context.Context {
				return context.WithValue(ctx, pollRequestKey{}, c.(*pollPipeConn).original)
			},
			Handler: http.HandlerFunc(func(w http.ResponseWriter, upgrade *http.Request) {
				original := upgrade.Context().Value(pollRequestKey{}).(*http.Request)
				g.tunnelUpgrade(w, upgrade, original)
			}),
		}
		u.listener, u.server = l, srv
		go srv.Serve(l)
	}
	l := u.listener
	u.mu.Unlock()

	transport := &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			client, server := net.Pipe()
			select {
			case l.conns <- &pollPipeConn{Conn: server, original: r}:
				return client, nil
			case <-l.done:
			case <-ctx.Done():
			}
			client.Close()
			server.Close()
			return nil, net.ErrClosed
		},
	}
	client := &http.Client{
		Transport:     transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return websocket.Dial(ctx, "ws://tabtop-internal/session", &websocket.DialOptions{HTTPClient: client})
}

func (u *pollUpstream) stop() {
	u.mu.Lock()
	u.stopped = true
	srv := u.server
	u.mu.Unlock()
	if srv != nil {
		srv.Close()
	}
}

package main

// The remote browser's egress proxy (see docs/browser-plan.md, section 3).
// The page engine, Moli, runs page scripts from any website, so everything
// it fetches goes through this proxy, which connects only where fetches may
// (fetchDialer, fetch.go's address policy), checked on the socket actually
// opened: whatever a name resolved to, after every redirect, and for
// tunnels too. In the sandbox the engine has no other way out; run without
// it (-go-unsandboxed), this proxy is all that keeps a page's requests off
// this machine and its networks.
//
// It's an ordinary HTTP forward proxy: plain requests with an absolute URL,
// forwarded as they are (redirects go back to the engine, which follows
// them through the proxy again), and CONNECT tunnels, which carry HTTPS and
// WebSocket. Only refusals are logged, by destination host, never a whole
// URL, which can hold a token.

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

// goProxyPorts are the ports the engine may reach, by CONNECT or by a
// plain request: HTTPS's and HTTP's. Other services on a public address
// (mail, databases, admin ports) stay out of a page's reach.
var goProxyPorts = map[string]bool{"443": true, "80": true}

// goProxyConns is how many connections one engine may have open through
// its proxy at once, tunnels and requests alike.
const goProxyConns = 64

// One engine's requests (and tunnels) are let through at goProxyRate a
// second, up to goProxyBurst at once, and goProxyBytes in all, both ways,
// for its life: everything it sends comes from this server's address, so
// a page mustn't be able to use it to flood a site. A busy page loads a
// few hundred things at once, and 60 heavy pages in a row move well under
// a gigabyte.
const (
	goProxyRate  = 30
	goProxyBurst = 300
	goProxyBytes = 4 << 30
)

var errGoProxyBytes = errors.New("this tab has used its traffic allowance; open a new one")

// goProxyBudget is an engine's allowance of requests and bytes.
type goProxyBudget struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
	bytes  atomic.Int64
	limit  int64
}

func newGoProxyBudget() *goProxyBudget {
	return &goProxyBudget{tokens: goProxyBurst, last: time.Now(), limit: goProxyBytes}
}

// request takes one request's worth, if there's one.
func (b *goProxyBudget) request() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens = min(goProxyBurst, b.tokens+now.Sub(b.last).Seconds()*goProxyRate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// spend counts n bytes, and says whether they're within the allowance.
func (b *goProxyBudget) spend(n int) bool { return b.bytes.Add(int64(n)) <= b.limit }

// spent is whether the byte allowance is used up.
func (b *goProxyBudget) spent() bool { return b.bytes.Load() > b.limit }

// goCountedWriter and goCountedBody count what goes through them against a
// budget, failing once it's spent.
type goCountedWriter struct {
	w io.Writer
	b *goProxyBudget
}

func (c goCountedWriter) Write(p []byte) (int, error) {
	if !c.b.spend(len(p)) {
		return 0, errGoProxyBytes
	}
	return c.w.Write(p)
}

type goCountedBody struct {
	io.ReadCloser
	b *goProxyBudget
}

func (c goCountedBody) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	if !c.b.spend(n) {
		return n, errGoProxyBytes
	}
	return n, err
}

type goProxy struct {
	dialer  *goDialer
	forward *httputil.ReverseProxy
	ports   map[string]bool
	auth    string // the Proxy-Authorization it needs; "" for none (a private socket)
	slots   chan struct{}
	budget  *goProxyBudget
	logf    func(format string, args ...any)
	mu      sync.Mutex
	closed  bool // close has been called: no more tunnels
	tunnels sync.WaitGroup
	done    chan struct{}
	// page is the host of the page the engine's showing, or loading (the
	// tab says: setPage): what ad blocking holds requests to. Nothing's
	// blocked as an ad while it isn't known.
	page atomic.Pointer[string]
	// onAd is told each host refused as an ad's (the tab counts them).
	onAd atomic.Pointer[func(host string)]
	// certs are the tab's certificate exceptions (gocert.go): while the
	// engine ignores certificate errors, others' certificates are checked
	// here, a tunnel to one not sound refused.
	certs atomic.Pointer[goCertExceptions]
}

// setPage says the engine's page is at host, from now.
func (p *goProxy) setPage(host string) {
	if p != nil {
		p.page.Store(&host)
	}
}

// adBlocked is whether a request to host is an ad's or a tracker's, for
// the page the engine's at.
func (p *goProxy) adBlocked(host string) bool {
	page := p.page.Load()
	if page == nil || !goAdBlocked(host, *page) {
		return false
	}
	if f := p.onAd.Load(); f != nil {
		(*f)(host)
	}
	return true
}

// newGoProxy is a proxy connecting where allow says. With user non-empty,
// requests must carry those credentials, as on a loopback port other
// processes can reach; on a socket only the engine's sandbox sees, none are
// needed.
func newGoProxy(allow func(netip.Addr) bool, user, password string) *goProxy {
	p := &goProxy{
		dialer: newGoDialer(allow),
		ports:  goProxyPorts,
		slots:  make(chan struct{}, goProxyConns),
		budget: newGoProxyBudget(),
		logf:   log.Printf,
		done:   make(chan struct{}),
	}
	if user != "" {
		p.auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
	}
	p.forward = &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			// The request's URL is already where it's going. Rewrite,
			// unlike Director, adds no X-Forwarded-For: the destination
			// isn't told about the engine.
			u := *pr.In.URL
			pr.Out.URL = &u
			pr.Out.Host = pr.In.URL.Host
			pr.Out.Header.Del("Proxy-Authorization")
			pr.Out.Header.Del("Proxy-Connection")
			if pr.Out.Body != nil && pr.Out.Body != http.NoBody {
				pr.Out.Body = goCountedBody{pr.Out.Body, p.budget}
			}
		},
		ModifyResponse: func(res *http.Response) error {
			res.Body = goCountedBody{res.Body, p.budget}
			res.Header.Del(goRefusedHeader) // only the proxy says it refused
			return nil
		},
		Transport: goDNSTransport(&http.Transport{
			Proxy:                 nil,
			DialContext:           p.dialer.DialContext,
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: time.Minute,
			// The engine asked for the encodings it can read; it gets the
			// bytes as sent.
			DisableCompression:  true,
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     30 * time.Second,
		}),
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, errGoDNS) {
				goRefuse(w, "dns", http.StatusBadGateway) // (the name not logged)
				return
			}
			if errors.Is(err, errFetchAddress) {
				p.logf("go: refused %s", r.URL.Host)
				goRefuse(w, "address", http.StatusForbidden)
				return
			}
			goRefuse(w, "unreachable", http.StatusBadGateway)
		},
	}
	return p
}

func (p *goProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if p.auth != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(p.auth)) != 1 {
		w.Header().Set("Proxy-Authenticate", `Basic realm="tabtop"`)
		http.Error(w, "Proxy authentication required.", http.StatusProxyAuthRequired)
		return
	}
	select {
	case p.slots <- struct{}{}:
		defer func() { <-p.slots }()
	default:
		goRefuse(w, "busy", http.StatusServiceUnavailable)
		return
	}
	if p.budget.spent() {
		goRefuse(w, "budget", http.StatusTooManyRequests)
		return
	}
	if !p.budget.request() {
		goRefuse(w, "rate", http.StatusTooManyRequests)
		return
	}
	if r.Method == http.MethodConnect {
		p.tunnel(w, r)
		return
	}
	if !r.URL.IsAbs() || r.URL.Host == "" || r.URL.User != nil || r.URL.Scheme != "http" && r.URL.Scheme != "https" {
		http.Error(w, "A proxy request needs an HTTP or HTTPS URL without credentials.", http.StatusBadRequest)
		return
	}
	port := r.URL.Port()
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[r.URL.Scheme]
	}
	if !p.ports[port] { // as goPortAllowed, with this proxy's ports
		goRefuse(w, "port", http.StatusForbidden)
		return
	}
	if goBlockedHost(r.URL.Hostname()) {
		goRefuse(w, "blocked", http.StatusForbidden)
		return
	}
	if p.adBlocked(r.URL.Hostname()) {
		goRefuse(w, "ads", http.StatusForbidden)
		return
	}
	p.forward.ServeHTTP(w, r)
}

// tunnel answers CONNECT: a connection to host:port, if the port is one
// tunnels may use and the address one fetches may reach, spliced to the
// engine's until either side closes it or the proxy does.
func (p *goProxy) tunnel(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || host == "" || !p.ports[port] {
		http.Error(w, "Tunnels go only to ports 80 and 443.", http.StatusForbidden)
		return
	}
	if goBlockedHost(host) {
		goRefuse(w, "blocked", http.StatusForbidden)
		return
	}
	if p.adBlocked(host) {
		goRefuse(w, "ads", http.StatusForbidden)
		return
	}
	// While the engine ignores certificate errors (its page an exception's:
	// gocert.go), it reaches no other host's HTTPS: that host's certificate
	// can't be checked here (not without intercepting it).
	if p.certs.Load().refuses(host) {
		p.logf("go: refused %s (the engine ignoring certificate errors, for an exception's)", host)
		goRefuse(w, "cert", http.StatusBadGateway)
		return
	}
	// HTTPS: its certificate looked up meanwhile, revoked refused
	// (gorevoke.go).
	// (Not a host the tab's continued to past the warning: gocert.go.)
	var revoked chan bool
	if port == "443" && !p.certs.Load().allows(host) {
		revoked = make(chan bool, 1)
		go func() { revoked <- goRevoked.revokedHost(r.Context(), host, p.dialer.DialContext) }()
	}
	up, err := p.dialer.DialContext(r.Context(), "tcp", r.Host)
	if err == nil && revoked != nil && <-revoked {
		up.Close()
		p.logf("go: refused %s (its certificate revoked by its issuer)", host)
		p.certs.Load().refusedRevoked(host) // (the tab warns of it: gobrowser.go)
		goRefuse(w, "revoked", http.StatusBadGateway)
		return
	}
	if err != nil {
		if errors.Is(err, errGoDNS) {
			goRefuse(w, "dns", http.StatusBadGateway) // (the name not logged)
			return
		}
		if errors.Is(err, errFetchAddress) {
			p.logf("go: refused %s", host)
			goRefuse(w, "address", http.StatusForbidden)
			return
		}
		goRefuse(w, "unreachable", http.StatusBadGateway)
		return
	}
	rc := http.NewResponseController(w)
	conn, buf, err := rc.Hijack()
	if err != nil {
		up.Close()
		return
	}
	if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		conn.Close()
		up.Close()
		return
	}
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		conn.Close()
		up.Close()
		return
	}
	p.tunnels.Add(1)
	p.mu.Unlock()
	defer p.tunnels.Done()
	stop := make(chan struct{})
	go func() {
		select {
		case <-p.done:
		case <-stop:
		}
		conn.Close()
		up.Close()
	}()
	copied := make(chan struct{})
	go func() {
		// Bytes the engine sent after its CONNECT, already read, first.
		out := goCountedWriter{up, p.budget}
		if n := buf.Reader.Buffered(); n > 0 {
			b, _ := buf.Reader.Peek(n)
			out.Write(b)
		}
		if _, err := io.Copy(out, conn); errors.Is(err, errGoProxyBytes) {
			up.Close() // spent: the other way stops too
		}
		closeWrite(up)
		close(copied)
	}()
	if _, err := io.Copy(goCountedWriter{conn, p.budget}, up); errors.Is(err, errGoProxyBytes) {
		conn.Close()
	}
	closeWrite(conn)
	<-copied
	close(stop)
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	} else {
		c.Close()
	}
}

// close ends every tunnel through the proxy, as when its engine is killed.
func (p *goProxy) close() {
	p.mu.Lock()
	if !p.closed {
		p.closed = true
		close(p.done)
	}
	p.mu.Unlock()
	p.tunnels.Wait()
}

// serve answers on l until l is closed, then ends the tunnels left open.
func (p *goProxy) serve(l net.Listener) error {
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 20 * time.Second, ErrorLog: log.New(io.Discard, "", 0)}
	err := srv.Serve(l)
	p.close()
	if errors.Is(err, net.ErrClosed) || errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// goRefusedHeader marks a response that's the proxy's own refusal, not a
// site's, with why (a key of goRefusals): an engine that shows it as the
// page (Obscura) rather than failing the load (Moli) is shown the reason
// instead (gobrowser.go). Taken out of the sites' responses.
const goRefusedHeader = "X-Tabtop-Go-Refused"

// goRefusals are the proxy's reasons for refusing, as the person is told.
var goRefusals = map[string]string{
	"address":     "That address can't be reached from here.",
	"unreachable": "The site couldn't be reached.",
	"port":        "Pages load only from ports 80 and 443.",
	"busy":        "Too many connections.",
	"budget":      errGoProxyBytes.Error(),
	"rate":        "Too many requests; slow down.",
	"blocked":     "This site is blocked in the browser's settings (Site controls: the button at the address’s start).",
	"ads":         "Blocked as an ad or tracker (☰ → Settings → Ad blocking).",
	"videos":      "Videos from this host are blocked (Site controls: the button at the address’s start).",
	"cert":        "Not reached while this tab ignores certificate errors for a site you continued to.",
	"dns":         "The site's name couldn't be found by the DNS over HTTPS server (Settings).",
	"revoked":     "This site's certificate has been revoked by its issuer, so it can't be trusted: the browser won't open it.",
}

// goRefuse answers with the proxy's refusal, for why.
func goRefuse(w http.ResponseWriter, why string, status int) {
	w.Header().Set(goRefusedHeader, why)
	http.Error(w, goRefusals[why], status)
}

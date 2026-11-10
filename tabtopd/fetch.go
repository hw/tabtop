package main

// Fetching from a URL into ~/Downloads: the gateway downloads it itself,
// so a big file goes straight to the machine rather than through the
// browser. The files page starts a fetch through the tunnel, and follows
// how it goes, but the fetch is the gateway's: closing the page doesn't
// stop it, and the page lists those going when it's opened again (see
// tunnelFetch). A connection cut off part way is carried on from where it
// stopped, if the server allows ranges, a few times.
//
// The gateway may sit where the person using it can't: beside the VNC
// server it logs in to, on a cloud machine with a metadata service, on a
// private network. So it only connects to public addresses, checked on
// the socket it actually opens (so a name that resolves somewhere else,
// a redirect, or "localhost" spelled oddly gets nowhere), and never to any
// of this machine's own addresses, whichever interface (see fetchPolicy).
// -fetch-private lets it reach private networks (a NAS, say), but never
// loopback, link-local or this machine's own addresses. It uses no proxy: one would make the
// address checked the proxy's. It logs only the host it fetches from:
// the rest of a URL can hold a token.
//
// The file is written as uploads are, to a hidden temporary file in its
// folder, then saved under its name, or the first free one like it.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const (
	// Fetches going at once.
	maxFetches = 4
	// How long one may go without getting a byte before it's cut off and
	// tried again, how many times a cut-off one is carried on with, and
	// how long one finished is still listed.
	fetchStall   = time.Minute
	fetchRetries = 5
	fetchKept    = 10 * time.Minute
	// How long, and how many, fetches finished are remembered after that,
	// to tell a page that follows one again (after its computer slept, say)
	// how it ended.
	fetchOutcomeKept = 24 * time.Hour
	maxFetchOutcomes = 200
	// How often a page following one is told how it's going.
	fetchTick = 500 * time.Millisecond
)

// fetchJob is a fetch, going or finished.
type fetchJob struct {
	id, host, dir string
	by, ip, who   string // the handle of the session that started it, where from, and what it's called
	cancel        context.CancelFunc
	done          chan struct{}

	mu         sync.Mutex
	name       string // what it's called so far; once done, what it was saved as
	got, total int64  // total is -1 if not known
	err        string // why it failed, once it has
	cancelled  bool
	warning    string
	tmp        string // its temporary file, in ~/Downloads, while it goes
}

// fetchState is a fetch as the page sees it.
type fetchState struct {
	ID    string `json:"id"`
	Host  string `json:"host"`
	Dir   string `json:"dir"`
	Name  string `json:"name"`
	Got   int64  `json:"got"`
	Total int64  `json:"total"`
	Done  bool   `json:"done,omitempty"`
	Error string `json:"error,omitempty"`
}

func (j *fetchJob) state() fetchState {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := fetchState{ID: j.id, Host: j.host, Dir: j.dir, Name: j.name, Got: j.got, Total: j.total, Error: j.err}
	select {
	case <-j.done:
		s.Done = true
	default:
	}
	return s
}

func (j *fetchJob) set(f func(*fetchJob)) {
	j.mu.Lock()
	f(j)
	j.mu.Unlock()
}

// fetchManager runs the fetches.
type fetchManager struct {
	downloadsDir string
	client       *http.Client
	// resourceClient loads previews' external resources. The URLs come
	// from the document being previewed, not the user, so it only ever
	// reaches public addresses, whatever -fetch-private says.
	resourceClient *http.Client
	transfers      *uploadManager
	activity       *activityLog

	mu       sync.Mutex
	jobs     map[string]*fetchJob
	outcomes map[string]fetchOutcome // by ID, those no longer listed
	wg       sync.WaitGroup
}

// fetchOutcome is how a fetch ended: its last state, and any warning.
type fetchOutcome struct {
	state   fetchState
	warning string
	at      time.Time
}

// outcome is how the fetch id ended, if it has, and isn't listed now.
func (m *fetchManager) outcome(id string) (fetchOutcome, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.outcomes[id]
	if ok && time.Since(o.at) >= fetchOutcomeKept {
		delete(m.outcomes, id)
		return fetchOutcome{}, false
	}
	return o, ok
}

// fetchSpare is what a fetch of a size not said leaves free, at least;
// tests change it.
var fetchSpare int64 = 256 << 20

// errFetchForgotten is what a page following a fetch is told when it ended
// so long ago it's not remembered how (see fetchOutcomeKept); the page
// knows it.
var errFetchForgotten = errors.New("That fetch finished a while ago.")

// errFetchAddress is a connection refused for where it goes.
var errFetchAddress = errors.New("that address is on this machine or a private network, which fetches don't go to")

// fetchAllowed reports whether a fetch may connect to a: a public address,
// or with private, one on a private network too; never this machine's, a
// link-local one (where most cloud metadata services are), another cloud
// metadata service's (see alwaysBlocked), or a multicast one.
func fetchAllowed(a netip.Addr, private bool) bool {
	a = a.Unmap()
	switch {
	case !a.IsValid(), a.IsUnspecified(), a.IsLoopback(), a.IsLinkLocalUnicast(), a.IsLinkLocalMulticast(),
		a.IsInterfaceLocalMulticast(), a.IsMulticast():
		return false
	}
	for _, p := range alwaysBlocked {
		if p.Contains(a) {
			return false
		}
	}
	if a.IsPrivate() {
		return private
	}
	for _, p := range privateRanges {
		if p.Contains(a) {
			return private
		}
	}
	return true
}

var (
	// "This network", broadcast, and IPv6 addresses that carry an IPv4
	// one inside, which could be one of the others; and the cloud metadata
	// services that aren't at link-local addresses, so even fetches allowed
	// private addresses can't fetch a machine's credentials: AWS's (IPv6),
	// Google Cloud's (IPv6), Alibaba Cloud's, Oracle Cloud's (old), and
	// Azure's WireServer.
	alwaysBlocked = []netip.Prefix{netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("255.255.255.255/32"),
		netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("2002::/16"),
		netip.MustParsePrefix("::/96"),
		netip.MustParsePrefix("fd00:ec2::254/128"), netip.MustParsePrefix("fd20:ce::254/128"),
		netip.MustParsePrefix("100.100.100.200/32"), netip.MustParsePrefix("192.0.0.192/32"),
		netip.MustParsePrefix("168.63.129.16/32")}
	// Shared address space (carrier-grade NAT), benchmarking networks, and
	// IPv6's old site-local addresses, which IsPrivate doesn't count.
	privateRanges = []netip.Prefix{netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("fec0::/10")}
)

// localAddr reports whether a is one of this machine's own addresses, on
// any of its interfaces: the container's own network address, say, or a
// public one the machine has itself. A service listening on all of them
// would be reached through it as through 127.0.0.1. If they can't be
// listed, every address counts as one.
func localAddr(a netip.Addr) bool {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return true
	}
	a = a.Unmap()
	for _, x := range addrs {
		if n, ok := x.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP); ok && ip.Unmap() == a {
				return true
			}
		}
	}
	return false
}

// fetchPolicy is where fetches may connect: what fetchAllowed allows (with
// private, private networks too), and never this machine's own addresses.
// They're listed again for every connection, as they can change.
func fetchPolicy(private bool) func(netip.Addr) bool {
	return func(a netip.Addr) bool { return fetchAllowed(a, private) && !localAddr(a) }
}

// newFetchClient is the client fetches use, connecting only where allow
// says.
func newFetchClient(allow func(netip.Addr) bool) *http.Client {
	dialer := &net.Dialer{Timeout: 20 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		ap, err := netip.ParseAddrPort(address)
		if err != nil || !allow(ap.Addr()) {
			return errFetchAddress
		}
		return nil
	}}
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: time.Minute,
			// The bytes as they are, so ranges count what's saved.
			DisableCompression: true,
			MaxIdleConns:       maxFetches,
			IdleConnTimeout:    30 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("it redirects too many times")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("it redirects to something other than http or https")
			}
			return nil
		},
	}
}

var errFetchBusy = fmt.Errorf("%d fetches are going already; wait for one to finish", maxFetches)

// start starts fetching u into dir, for the session by.
func (m *fetchManager) start(u *url.URL, dir, by, ip, who string) (*fetchJob, error) {
	b := make([]byte, 8)
	rand.Read(b)
	ctx, cancel := context.WithCancel(context.Background())
	j := &fetchJob{id: hex.EncodeToString(b), host: u.Host, dir: dir, by: by, ip: ip, who: who, cancel: cancel, done: make(chan struct{}),
		name: urlName(u), total: -1}
	m.mu.Lock()
	going := 0
	for _, o := range m.jobs {
		if o.state().Done {
			continue
		}
		going++
	}
	if going >= maxFetches {
		m.mu.Unlock()
		cancel()
		return nil, errFetchBusy
	}
	if m.jobs == nil {
		m.jobs = map[string]*fetchJob{}
	}
	m.jobs[j.id] = j
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		defer cancel()
		err := m.run(ctx, j, u)
		j.set(func(j *fetchJob) {
			switch {
			case err == nil:
			case ctx.Err() != nil:
				j.cancelled = true
				j.err = "cancelled"
			default:
				j.err = err.Error()
			}
		})
		close(j.done)
		s := j.state()
		switch {
		case err == nil:
			m.activity.addAs(j.who, "fetch", ip, "fetched %s (%s) from %s into %s", s.Name, humanSize(s.Got), j.host, folderText(dir))
		case ctx.Err() != nil:
			m.activity.addAs(j.who, "fetch", ip, "fetch of %s from %s cancelled", s.Name, j.host)
		default:
			log.Printf("fetch from %s into %q failed: %v", j.host, dir, err)
			m.activity.addAs(j.who, "fetch", ip, "fetch from %s failed: %v", j.host, err)
		}
		time.AfterFunc(fetchKept, func() { m.forget(j) })
	}()
	log.Printf("fetching from %s into %q", j.host, dir)
	return j, nil
}

// forget stops listing j, which has ended, and remembers how it did.
func (m *fetchManager) forget(j *fetchJob) {
	j.mu.Lock()
	warning := j.warning
	j.mu.Unlock()
	out := fetchOutcome{state: j.state(), warning: warning, at: time.Now()}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.jobs, j.id)
	if m.outcomes == nil {
		m.outcomes = map[string]fetchOutcome{}
	}
	for id, o := range m.outcomes {
		if time.Since(o.at) >= fetchOutcomeKept {
			delete(m.outcomes, id)
		}
	}
	for len(m.outcomes) >= maxFetchOutcomes {
		oldest := ""
		for id, o := range m.outcomes {
			if oldest == "" || o.at.Before(m.outcomes[oldest].at) {
				oldest = id
			}
		}
		delete(m.outcomes, oldest)
	}
	m.outcomes[j.id] = out
}

func (m *fetchManager) job(id string) *fetchJob {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[id]
}

// list lists the fetches, oldest first.
func (m *fetchManager) list() []fetchState {
	m.mu.Lock()
	jobs := make([]*fetchJob, 0, len(m.jobs))
	for _, j := range m.jobs {
		jobs = append(jobs, j)
	}
	m.mu.Unlock()
	out := []fetchState{}
	for _, j := range jobs {
		out = append(out, j.state())
	}
	return out
}

// cancelMatching cancels the fetches going that match, and reports how
// many.
func (m *fetchManager) cancelMatching(match func(*fetchJob) bool) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, j := range m.jobs {
		if match(j) && !j.state().Done {
			j.cancel()
			n++
		}
	}
	return n
}

// stop cancels every fetch, and waits for them to delete what they had,
// until ctx ends.
func (m *fetchManager) stop(ctx context.Context) {
	m.cancelMatching(func(*fetchJob) bool { return true })
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// fetchError is what to tell the page about err from a request: without
// the URL, which Go puts in it, and which can hold a token.
func fetchError(err error) error {
	if ue, ok := errors.AsType[*url.Error](err); ok {
		err = ue.Err
	}
	switch {
	case errors.Is(err, errFetchAddress):
		return errFetchAddress
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, errFetchStalled):
		return errors.New("the server stopped sending")
	}
	if oe, ok := errors.AsType[*net.OpError](err); ok && oe.Op == "dial" {
		return fmt.Errorf("can't connect: %v", oe.Err)
	}
	if de, ok := errors.AsType[*net.DNSError](err); ok {
		if de.IsNotFound {
			return errors.New("no such host")
		}
		return errors.New("can't look up the host")
	}
	return err
}

var errFetchStalled = errors.New("stalled")

// run fetches u for j, into a temporary file, then saves it.
func (m *fetchManager) run(ctx context.Context, j *fetchJob, u *url.URL) error {
	store, err := openDownloadStore(m.downloadsDir)
	if err != nil {
		return errors.New("the downloads folder is missing")
	}
	defer store.Close()
	up, err := store.startUpload(j.dir)
	if err != nil {
		return errors.New(strings.TrimSuffix(uploadError(err), "."))
	}
	j.set(func(j *fetchJob) { j.tmp = up.tmp })
	saved := false
	defer func() {
		if !saved {
			up.abort()
		}
	}()
	var (
		got       int64
		total     int64  = -1
		validator string      // the ETag or Last-Modified that a range must match
		room      int64  = -1 // for one of a size not said, the most it may come to
		ranges    bool        // the server said it takes ranges
		name      string
	)
	for try := 0; ; try++ {
		if try > 0 {
			select {
			case <-time.After(time.Duration(min(1<<try, 30)) * time.Second):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		n, retry, err := func() (int64, bool, error) {
			actx, stall := context.WithCancelCause(ctx)
			defer stall(nil)
			req, err := http.NewRequestWithContext(actx, http.MethodGet, u.String(), nil)
			if err != nil {
				return 0, false, err
			}
			req.Header.Set("User-Agent", "TabTop")
			req.Header.Set("Accept-Encoding", "identity")
			if got > 0 {
				req.Header.Set("Range", fmt.Sprintf("bytes=%d-", got))
				if validator != "" {
					req.Header.Set("If-Range", validator)
				}
			}
			timer := time.AfterFunc(fetchStall, func() { stall(errFetchStalled) })
			defer timer.Stop()
			res, err := m.client.Do(req)
			if err != nil {
				if context.Cause(actx) == errFetchStalled && ctx.Err() == nil {
					return 0, true, errFetchStalled
				}
				return 0, false, fetchError(err)
			}
			defer res.Body.Close()
			switch {
			case got > 0 && res.StatusCode == http.StatusPartialContent && contentRangeStart(res.Header.Get("Content-Range")) == got:
			case res.StatusCode == http.StatusOK:
				if got > 0 {
					// Starting again from the beginning.
					if err := restart(up); err != nil {
						return 0, false, err
					}
					got = 0
				}
				total = res.ContentLength
				validator = strongValidator(res.Header)
				ranges = res.Header.Get("Accept-Ranges") == "bytes"
				if name == "" {
					name = responseName(res)
					j.set(func(j *fetchJob) { j.name = name })
				}
				if total > 0 {
					if free, ok := m.transfers.reclaimPartials(up.f, total); ok && total > free {
						return 0, false, fmt.Errorf("there isn't room for it: it's %s, and %s is free", humanSize(total), humanSize(free))
					}
				} else if free, ok := m.transfers.reclaimPartials(up.f, 0); ok {
					// Not said how big it is: it may take what's free, less
					// some to spare, and no more, so a server sending without
					// end can't fill the disk.
					room = max(0, free-fetchSpare)
				}
			default:
				return 0, false, fmt.Errorf("the server answered %s", res.Status)
			}
			j.set(func(j *fetchJob) { j.got, j.total = got, total })
			buf := make([]byte, 256<<10)
			var n int64
			for {
				k, rerr := res.Body.Read(buf)
				if k > 0 {
					timer.Reset(fetchStall)
					if room >= 0 && got+n+int64(k) > room {
						return n, false, fmt.Errorf("it's bigger than the room on the disk (%s, keeping %s free)", humanSize(room), humanSize(fetchSpare))
					}
					if _, err := up.Write(buf[:k]); err != nil {
						return n, false, errors.New(strings.TrimSuffix(uploadError(err), "."))
					}
					n += int64(k)
					j.set(func(j *fetchJob) { j.got = got + n })
				}
				if rerr == io.EOF {
					if total >= 0 && got+n != total {
						return n, true, io.ErrUnexpectedEOF
					}
					return n, false, nil
				}
				if rerr != nil {
					if ctx.Err() != nil {
						return n, false, ctx.Err()
					}
					return n, true, rerr
				}
			}
		}()
		got += n
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !retry || try >= fetchRetries {
			if retry {
				return errors.New("the connection kept being cut off")
			}
			return err
		}
		if got > 0 && (!ranges || validator == "") {
			// Can't carry on: start again. Only a server that takes
			// ranges, and says which version of the file it sent (an ETag
			// or Last-Modified, for If-Range), can be asked for the rest:
			// without that, the rest could be of another version.
			if err := restart(up); err != nil {
				return err
			}
			got = 0
		}
		log.Printf("fetch from %s cut off at %s; trying again", j.host, humanSize(got))
	}
	if name == "" {
		name = "download"
	}
	as, err := up.finish(name, false)
	saved = true
	if err != nil {
		return errors.New(strings.TrimSuffix(uploadError(err), "."))
	}
	j.set(func(j *fetchJob) {
		j.name = as
		if up.unsynced {
			j.warning = "saved, but the disk didn't confirm it"
		}
	})
	log.Printf("fetched %q (%s) from %s", path.Join(j.dir, as), humanSize(got), j.host)
	return nil
}

// restart empties what up has, to fetch it again from the start.
func restart(up *upload) error {
	if err := up.f.Truncate(0); err != nil {
		return err
	}
	_, err := up.f.Seek(0, io.SeekStart)
	return err
}

// contentRangeStart is where a Content-Range header says its bytes start,
// or -1.
func contentRangeStart(h string) int64 {
	var start, end, size int64
	if _, err := fmt.Sscanf(h, "bytes %d-%d/%d", &start, &end, &size); err == nil {
		return start
	}
	if _, err := fmt.Sscanf(h, "bytes %d-%d/*", &start, &end); err == nil {
		return start
	}
	return -1
}

// strongValidator is what If-Range can be given to make sure a range is
// of the same file: a strong ETag, else Last-Modified.
func strongValidator(h http.Header) string {
	if e := h.Get("ETag"); e != "" && !strings.HasPrefix(e, "W/") {
		return e
	}
	return h.Get("Last-Modified")
}

// responseName is the name to save what res holds as: the one its server
// gives it, else the last part of where it came from.
func responseName(res *http.Response) string {
	if _, params, err := mime.ParseMediaType(res.Header.Get("Content-Disposition")); err == nil {
		if n := cleanFetchName(params["filename"]); n != "" {
			return n
		}
	}
	if n := urlName(res.Request.URL); n != "" {
		return n
	}
	return "download"
}

func urlName(u *url.URL) string { return cleanFetchName(path.Base(u.Path)) }

// cleanFetchName makes name one that can be saved: its last part, without
// control characters, not hidden, short enough; or "" if nothing's left.
func cleanFetchName(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(name, ""))
	name = strings.TrimSpace(strings.TrimLeft(name, "."))
	for len(name) > maxNameBytes {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if !validNewName(name) {
		return ""
	}
	return name
}

// tunnelFetch answers a fetch request: with req.URL, it starts fetching it
// into the folder at req.Path; with req.Name, it follows the fetch with
// that id. Either way it replies with the fetch's state (see fetchState),
// and again every fetchTick, while the page follows it; the last has Done,
// and the name it was saved as, or Error. A text message from the page
// cancels it. The page going doesn't.
func (g *server) tunnelFetch(t *tunnel, req tunnelRequest, session, ip string, r *tunnelResponder) {
	if g.fetches == nil {
		r.fail("Fetching from URLs is turned off (WEB_FETCH=0).")
		return
	}
	var j *fetchJob
	if req.Name != "" {
		if j = g.fetches.job(req.Name); j == nil {
			// No longer listed: how it ended, if that's remembered, as a
			// page following it is told when it ends.
			o, ok := g.fetches.outcome(req.Name)
			switch {
			case !ok:
				r.fail(errFetchForgotten.Error())
			case o.state.Error != "":
				r.fail(o.state.Error)
			default:
				res := map[string]any{"fetch": o.state}
				if o.warning != "" {
					res["warning"] = o.warning
				}
				if r.accept(map[string]any{"fetch": o.state}) {
					r.finish(res)
				}
			}
			return
		}
	} else {
		u, err := url.Parse(strings.TrimSpace(req.URL))
		if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" {
			r.fail("Give an http:// or https:// address.")
			return
		}
		dir := strings.Trim(req.Path, "/")
		if dir == "" {
			dir = "."
		}
		if j, err = g.fetches.start(u, path.Clean(dir), sessionHandle(session), ip, g.sessionName(session)); err != nil {
			r.fail(err.Error())
			return
		}
	}
	if !r.accept(map[string]any{"fetch": j.state()}) {
		return
	}
	// A text message cancels; the page going just stops this.
	gone := make(chan struct{})
	go func() {
		defer close(gone)
		for {
			typ, _, err := t.Read(context.Background())
			if err != nil {
				return
			}
			if typ == websocket.MessageText {
				j.cancel()
			}
		}
	}()
	tick := time.NewTicker(fetchTick)
	defer tick.Stop()
	for {
		select {
		case <-j.done:
			s := j.state()
			if s.Error != "" {
				r.fail(s.Error)
				return
			}
			res := map[string]any{"fetch": s}
			j.mu.Lock()
			if j.warning != "" {
				res["warning"] = j.warning
			}
			j.mu.Unlock()
			r.finish(res)
			return
		case <-gone:
			return
		case <-tick.C:
			if err := writeJSON(t, map[string]any{"fetch": j.state()}); err != nil {
				return
			}
		}
	}
}

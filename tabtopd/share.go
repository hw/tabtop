package main

// Share links: plain HTTPS URLs for a file or folder in ~/Downloads, which
// someone else, or wget and curl, can fetch without logging in or the
// tunnel's JavaScript. A logged-in page makes one through the tunnel (see
// tunnelShare in tunnel_request.go); the URL is
//
//	<base>fs/<token>/<name>
//
// where the token, 128 random bits, is the whole permission: the name is
// only there so wget saves under it. The gateway keeps the token's SHA-256,
// not the token, in -shares-file, so links last across restarts.
//
// What a link serves doesn't go through the encrypted tunnel: a proxy that
// decrypts HTTPS on the way sees the link and the file. That's what plain
// URLs are, so links are only made when asked for, and WEB_SHARE=0 turns
// them off altogether.
//
// A file is sent as a download, never shown as a page (as every file the
// site serves), with ranges, so wget -c and curl -C - carry on with one cut
// off. A folder is sent as a zip made as it goes, of what it holds then. A
// link ends when it expires, when it has been downloaded as many times as
// it allows, when it's revoked, and when the file it was made for is
// replaced, changed or moved: it records the file's inode, size and
// modification time, and serves nothing else. Ending a session (End…)
// revokes the links it made, and Log out everywhere revokes every link, so
// someone who got a session can't keep access through one.

import (
	"archive/zip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// Longest a link may last.
	maxShareLife = 7 * 24 * time.Hour
	// Most links kept at once; making one past that drops the one that ends
	// soonest.
	maxShares = 200
	// Requests for links that don't exist, from one address (see
	// limitKey), per shareMissWindow, past which its requests for links are
	// refused until the window passes, so nobody can scan for them.
	maxShareMisses  = 20
	shareMissWindow = 10 * time.Minute
	// Addresses whose misses are counted at once: past that, the one that
	// missed longest ago is forgotten, so many addresses can't grow it
	// without end.
	maxMissAddresses = 10_000
	// Downloads remembered per link, for the security page.
	maxShareUses = 20
	// For a link with a limit, as many as the limit, up to this.
	maxShareUsesLimited = 1000
	shareTokenBytes     = 16
)

// shareToken is what a link's token looks like: 16 bytes, base64url.
var shareToken = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// shareLink is a link, as kept in -shares-file.
type shareLink struct {
	ID      string    `json:"id"`   // the token's SHA-256, hex
	Path    string    `json:"path"` // in ~/Downloads, without slashes at either end
	Dir     bool      `json:"dir,omitempty"`
	Ino     uint64    `json:"ino"` // what it was made for: see matches
	Size    int64     `json:"size,omitempty"`
	ModTime int64     `json:"mtime,omitempty"` // Unix nanoseconds
	Created time.Time `json:"created"`
	Expires time.Time `json:"expires"`
	Max     int       `json:"max,omitempty"` // downloads it allows; 0 for no limit
	// Made for one download by the files page itself (a preview's Direct
	// Download): it goes once that's done, whole.
	Once  bool       `json:"once,omitempty"`
	Count int        `json:"count,omitempty"`
	By    string     `json:"by"`    // the handle of the session that made it (see sessionHandle)
	ByIP  string     `json:"by_ip"` // where that session made it from
	Uses  []shareUse `json:"uses,omitempty"`
	// A note for the people who can log in, such as who it's for; never
	// shown to someone using the link
	Label string `json:"label,omitempty"`
	// The token, sealed, to show the link again (see share_key.go)
	Sealed string `json:"sealed,omitempty"`
	// An upload link, into the folder at Path (see share_upload.go): Max
	// and Count are then files, not downloads, and MaxBytes caps what all
	// of them come to, Bytes so far.
	Upload   bool  `json:"upload,omitempty"`
	MaxBytes int64 `json:"max_bytes,omitempty"`
	Bytes    int64 `json:"bytes,omitempty"`

	// Uploads going on, and the bytes they've written, not yet counted.
	pending      int
	pendingBytes int64

	revoked atomic.Bool // ends downloads going on when it's revoked
	// The Download button's tickets (see ticket), to the address each was
	// given to; not kept across restarts.
	tickets map[string]string
}

// shareUse is a download of a link, or a file uploaded with one.
type shareUse struct {
	IP   string    `json:"ip"`
	Time time.Time `json:"time"`
	Name string    `json:"name,omitempty"` // an upload's: what it was saved as
	Size int64     `json:"size,omitempty"`
}

func (l *shareLink) name() string {
	if l.Path == "." {
		return "Downloads"
	}
	return path.Base(l.Path)
}

// handle names a link in the page, to revoke it by, without its token.
func (l *shareLink) handle() string { return l.ID[:16] }

// matches reports whether st is what the link was made for. The inode
// alone, for a folder; a file must also have the same size and
// modification time, so one changed in place isn't served either. Not the
// device: a volume's can change when the container is made again.
func (l *shareLink) matches(st fs.FileInfo) bool {
	sys, ok := identitySys(st)
	if !ok || uint64(sys.Ino) != l.Ino || st.IsDir() != l.Dir {
		return false
	}
	return l.Dir || st.Mode().IsRegular() && st.Size() == l.Size && st.ModTime().UnixNano() == l.ModTime
}

// shareStore holds the links, and writes them to file (if it isn't "")
// whenever they change.
type shareStore struct {
	file  string
	clock lifecycleClock

	mu     sync.Mutex
	links  map[string]*shareLink // by ID
	misses map[string][]time.Time
	// When misses was last cleared of addresses that haven't missed
	// lately (see pruneMissesLocked).
	missesPruned time.Time

	// Uploads through links in pieces, under way (see share_chunks.go).
	partials linkPartials
	// What tokens are sealed with (see share_key.go).
	key []byte

	// A save to come (see saveSoonLocked), and when each link's downloads
	// by each address were last logged (see logUse).
	saveTimer lifecycleTimer
	logged    map[string]time.Time

	// Downloads through links going, by address (see startDownload).
	downloads    map[string]int
	downloadsAll int
	// Uploads through links going, all told (see reserve).
	uploadsAll int
	// Multipart requests are admitted before parsing fields, including ignored
	// fields and files rejected before reserve can take a transfer slot.
	formsAll int
	forms    map[string]int
}

// errTooManyShares is a link refused as there are maxShares already.
var errTooManyShares = fmt.Errorf("There are %d links already, as many as can be kept. Revoke some (from Share links), then make this one.", maxShares)

// shareSaveDelay is how soon a link's count is saved after a download, for
// links without a limit: one save for many downloads.
const shareSaveDelay = 5 * time.Second

// shareLogEvery is how often a link without a limit has its downloads by
// the same address logged.
const shareLogEvery = 10 * time.Minute

// saveSoonLocked saves the links within shareSaveDelay, with whatever else
// changes meanwhile; s.mu must be held.
func (s *shareStore) saveSoonLocked() {
	if s.saveTimer != nil || s.file == "" {
		return
	}
	s.saveTimer = s.clock.AfterFunc(shareSaveDelay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.saveTimer = nil
		s.saveLocked()
	})
}

// flush saves the links now, if a save is to come, as the gateway stops.
func (s *shareStore) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saveTimer != nil {
		s.saveTimer.Stop()
		s.saveTimer = nil
		s.saveLocked()
	}
}

// logUse reports whether a download of l by ip is to be logged: each is,
// for a link with a limit, which has as many as that; for one without,
// once in shareLogEvery for each address, so that downloading it over and
// over can't fill the logs, or push all else out of the activity log.
func (s *shareStore) logUse(l *shareLink, ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	// (Its limit, read under the lock: it can be changed meanwhile.)
	if l.Max > 0 {
		return true
	}
	now := s.clock.Now()
	key := l.ID + " " + limitKey(ip)
	if last, ok := s.logged[key]; ok && now.Sub(last) < shareLogEvery {
		return false
	}
	if s.logged == nil || len(s.logged) >= maxMissAddresses {
		for k, t := range s.logged {
			if now.Sub(t) >= shareLogEvery {
				delete(s.logged, k)
			}
		}
		if s.logged == nil || len(s.logged) >= maxMissAddresses {
			s.logged = map[string]time.Time{}
		}
	}
	s.logged[key] = now
	return true
}

func newShareStore(file string, clock lifecycleClock) *shareStore {
	s := &shareStore{file: file, clock: clock, links: map[string]*shareLink{}, misses: map[string][]time.Time{}, key: newShareKey()}
	if file == "" {
		return s
	}
	data, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			// Not saved over, so its links are there to read once it can be.
			log.Printf("share links: %v; starting with none, and not saving any till a restart", err)
			s.file = ""
		}
		return s
	}
	var saved struct {
		Links []json.RawMessage `json:"links"`
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		// Set aside, its links kept to mend, rather than saved over.
		aside, aerr := setAside(file)
		if aerr != nil {
			log.Printf("share links: %s isn't readable (%v), and can't be set aside (%v); starting with none, and not saving any till a restart", file, err, aerr)
			s.file = ""
			return s
		}
		log.Printf("share links: %s isn't readable (%v); set aside as %s, starting with none", file, err, aside)
		return s
	}
	now := clock.Now()
	for _, raw := range saved.Links {
		l := &shareLink{}
		// Anything that doesn't parse, or doesn't look like a link made
		// here, is left out: the file is the desktop user's to change.
		if json.Unmarshal(raw, l) != nil || len(l.ID) != 64 || l.Path == "" || !now.Before(l.Expires) {
			continue
		}
		if _, err := hex.DecodeString(l.ID); err != nil {
			continue
		}
		s.links[l.ID] = l
	}
	return s
}

// saveLocked writes the links to s.file, all or nothing. s.mu must be held.
func (s *shareStore) saveLocked() {
	if s.file == "" {
		return
	}
	links := make([]*shareLink, 0, len(s.links))
	for _, l := range s.links {
		links = append(links, l)
	}
	slices.SortFunc(links, func(a, b *shareLink) int { return a.Created.Compare(b.Created) })
	data, err := json.MarshalIndent(map[string]any{"version": 1, "links": links}, "", "  ")
	if err == nil {
		err = writeFileAtomic(s.file, data)
	}
	if err != nil {
		log.Printf("share links: saving: %v", err)
	}
}

// syncFile puts f on disk; tests make it fail.
var syncFile = (*os.File).Sync

// writeFileAtomic replaces file with data, readable only by its owner, in a
// folder only it can open.
func writeFileAtomic(file string, data []byte) error {
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".shares-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // gone once renamed
	// Only a file written whole, on disk, and closed replaces the old one.
	_, err = f.Write(data)
	if err == nil {
		err = syncFile(f)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(f.Name(), file); err != nil {
		return err
	}
	// And the folder, so the rename is on disk too: without it, a power
	// cut can bring back the old file, or none. A file system that can't
	// sync a folder goes as far as the file being synced.
	return syncFolder(dir)
}

// syncFolder puts what's changed in the folder dir on disk.
func syncFolder(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = syncFile(d)
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	if errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP) {
		return nil
	}
	return err
}

// pruneLocked drops the links that have expired. One downloaded as many
// times as it allows stays until then, so the downloads can carry on if
// cut off, and the security page shows it. s.mu must be held.
func (s *shareStore) pruneLocked(now time.Time) bool {
	changed := false
	for id, l := range s.links {
		if !now.Before(l.Expires) {
			delete(s.links, id)
			changed = true
		}
	}
	return changed
}

// shareSpec is how a link is to work: how long it lasts, how many
// downloads (or files, for an upload link) it allows, 0 for no limit, and
// for an upload link, how much it may take in all.
type shareSpec struct {
	Label    string
	Life     time.Duration
	Max      int
	Upload   bool
	MaxBytes int64
	Once     bool
}

// create makes a link to what's at p in ~/Downloads, st, as spec says, for
// the session by from ip, and returns its token.
func (s *shareStore) create(p string, st fs.FileInfo, spec shareSpec, by, ip string) (string, *shareLink, error) {
	sys, ok := identitySys(st)
	if !ok {
		return "", nil, errors.New("can't tell what file this is")
	}
	b := make([]byte, shareTokenBytes)
	rand.Read(b)
	token := base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(token))
	now := s.clock.Now()
	l := &shareLink{ID: hex.EncodeToString(sum[:]), Path: p, Dir: st.IsDir(), Ino: uint64(sys.Ino),
		Created: now, Expires: now.Add(spec.Life), Max: spec.Max, By: by, ByIP: ip, Upload: spec.Upload, MaxBytes: spec.MaxBytes, Label: spec.Label, Once: spec.Once}
	if !l.Dir {
		l.Size, l.ModTime = st.Size(), st.ModTime().UnixNano()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(now)
	if len(s.links) >= maxShares {
		// Refused, rather than ending another link (perhaps another
		// session's) to make room, unseen.
		return "", nil, errTooManyShares
	}
	l.Sealed = s.seal(l.ID, token)
	s.links[l.ID] = l
	s.saveLocked()
	return token, l, nil
}

// lookup finds the link for token, if it's live, counting a miss against
// ip's address otherwise. limited is true if ip has missed too often lately
// to be answered at all.
func (s *shareStore) lookup(token, ip string) (l *shareLink, limited bool) {
	sum := sha256.Sum256([]byte(token))
	key := limitKey(ip)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	if now.Sub(s.missesPruned) >= shareMissWindow/2 {
		s.pruneMissesLocked(now)
	}
	recent := slices.DeleteFunc(s.misses[key], func(t time.Time) bool { return now.Sub(t) >= shareMissWindow })
	if len(recent) >= maxShareMisses {
		s.misses[key] = recent
		return nil, true
	}
	l = s.links[hex.EncodeToString(sum[:])]
	if l == nil || !now.Before(l.Expires) {
		recent = append(recent, now)
		l = nil
	}
	if len(recent) == 0 {
		delete(s.misses, key)
		return l, false
	}
	if _, known := s.misses[key]; !known && len(s.misses) >= maxMissAddresses {
		s.pruneMissesLocked(now)
		if len(s.misses) >= maxMissAddresses {
			oldest := ""
			for k, ts := range s.misses {
				if oldest == "" || ts[len(ts)-1].Before(s.misses[oldest][len(s.misses[oldest])-1]) {
					oldest = k
				}
			}
			delete(s.misses, oldest)
		}
	}
	s.misses[key] = recent
	return l, false
}

// pruneMissesLocked forgets the addresses that haven't missed within
// shareMissWindow, which lookup otherwise only does when they come back.
// s.mu must be held.
func (s *shareStore) pruneMissesLocked(now time.Time) {
	for k, ts := range s.misses {
		if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= shareMissWindow {
			delete(s.misses, k)
		}
	}
	s.missesPruned = now
}

var errShareUsedUp = errors.New("this link has been downloaded as many times as it allows")

// use records a download of l from ip, unless it has been downloaded as
// many times as it allows. A request that carries on from part way through
// (resume) doesn't count, but for a link with a limit, only an address that
// has already downloaded it may make one.
func (s *shareStore) use(l *shareLink, ip string, resume bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.links[l.ID] != l {
		return errShareUsedUp // revoked, or ended, since it was looked up
	}
	if resume {
		if l.Max > 0 && !slices.ContainsFunc(l.Uses, func(u shareUse) bool { return u.IP == ip }) {
			return errShareUsedUp
		}
		return nil
	}
	if l.Max > 0 && l.Count >= l.Max {
		return errShareUsedUp
	}
	l.Count++
	l.Uses = append(l.Uses, shareUse{IP: ip, Time: s.clock.Now()})
	// As many as it allows downloads (to a point), so each that downloaded
	// it can carry on.
	keep := maxShareUses
	if l.Max > keep {
		keep = min(l.Max, maxShareUsesLimited)
	}
	if len(l.Uses) > keep {
		l.Uses = l.Uses[len(l.Uses)-keep:]
	}
	if l.Max > 0 {
		// Its limit holds across restarts: saved now.
		s.saveLocked()
	} else {
		s.saveSoonLocked()
	}
	return nil
}

// shareNow is what of a link can change, as it is at one moment.
type shareNow struct {
	Count, Max      int
	Bytes, MaxBytes int64
	Expires         time.Time
}

// now is l as it is: it can be used, or changed (see change), meanwhile.
func (s *shareStore) now(l *shareLink) shareNow {
	s.mu.Lock()
	defer s.mu.Unlock()
	return shareNow{l.Count, l.Max, l.Bytes, l.MaxBytes, l.Expires}
}

// ticket gives ip, which has just counted a download of l with the page's
// Download button, a ticket to fetch it with, without counting again,
// however often the browser carries on with it.
func (s *shareStore) ticket(l *shareLink, ip string) string {
	b := make([]byte, shareTokenBytes)
	rand.Read(b)
	t := base64.RawURLEncoding.EncodeToString(b)
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.tickets == nil {
		l.tickets = map[string]string{}
	}
	if len(l.tickets) >= maxShareUses {
		for k := range l.tickets {
			delete(l.tickets, k)
			break
		}
	}
	l.tickets[t] = ip
	return t
}

// redeem reports whether t is a ticket for l given to ip.
func (s *shareStore) redeem(l *shareLink, t, ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return t != "" && s.links[l.ID] == l && l.tickets[t] == ip
}

// errShareChange is a change a link can't have; its message says why.
type errShareChange string

func (e errShareChange) Error() string { return string(e) }

// change changes the link with handle: to last life from now (0 keeps when
// it ends), and allow max downloads or files in all (0 for no limit), and
// for an upload link, maxBytes in all. A link used up can be given more,
// and one that has ended can't be brought back.
func (s *shareStore) change(handle string, life time.Duration, max int, maxBytes int64, label string) (*shareLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	s.pruneLocked(now)
	var l *shareLink
	for _, o := range s.links {
		if o.handle() == handle {
			l = o
		}
	}
	if l == nil {
		return nil, errShareChange("That link has ended already.")
	}
	used := "downloaded"
	if l.Upload {
		used = "sent files"
	}
	// What it has taken, with what's coming now: uploads going on can't
	// be refused once they've begun.
	count, bytes, going := l.Count, l.Bytes, ""
	if l.Upload && l.pending > 0 {
		count, bytes, going = l.Count+l.pending, l.Bytes+l.pendingBytes, ", with those going on"
	}
	switch {
	case max > 0 && max < count:
		return nil, errShareChange(fmt.Sprintf("It has been %s %d times already%s: allow at least that many.", used, count, going))
	case l.Upload && (maxBytes <= 0 || maxBytes > maxUploadLinkBytes):
		return nil, errShareChange("An upload link needs a limit on what it takes.")
	case l.Upload && maxBytes < bytes:
		return nil, errShareChange(fmt.Sprintf("It has taken %s already%s: allow at least that.", humanSize(bytes), going))
	case !l.Upload && maxBytes != 0:
		return nil, errShareChange("That's not a limit a download link can have.")
	}
	if life > 0 {
		l.Expires = now.Add(life)
	}
	l.Max = max
	l.Label = label
	if l.Upload {
		l.MaxBytes = maxBytes
	}
	s.saveLocked()
	return l, nil
}

// changeMany makes the links with handles end life from now (0 keeps when
// each ends), and with relabel, labels them label, and returns what they
// were to, for the activity log. Their limits stay as they are.
func (s *shareStore) changeMany(handles []string, life time.Duration, label string, relabel bool) []string {
	want := map[string]bool{}
	for _, h := range handles {
		want[h] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock.Now()
	s.pruneLocked(now)
	var changed []string
	for _, l := range s.links {
		if !want[l.handle()] {
			continue
		}
		if life > 0 {
			l.Expires = now.Add(life)
		}
		if relabel {
			l.Label = label
		}
		changed = append(changed, linkTarget(l))
	}
	if len(changed) > 0 {
		s.saveLocked()
	}
	return changed
}

// revoke ends the links that match, ending their downloads going on, and
// reports how many there were.
func (s *shareStore) revoke(match func(*shareLink) bool) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, l := range s.links {
		if match(l) {
			l.revoked.Store(true)
			delete(s.links, id)
			n++
		}
	}
	if n > 0 {
		s.saveLocked()
	}
	return n
}

// shareInfo is a link, as the security page lists it.
type shareInfo struct {
	Handle  string     `json:"handle"`
	Path    string     `json:"path"`
	Dir     bool       `json:"dir"`
	Created time.Time  `json:"created"`
	Expires time.Time  `json:"expires"`
	Max     int        `json:"max"`
	Count   int        `json:"count"`
	ByIP    string     `json:"by_ip"`
	Mine    bool       `json:"mine"` // made by the session asking
	Uses    []shareUse `json:"uses"`
	Shown   bool       `json:"shown"` // can be shown again (see shareLinkAgain)
	Label   string     `json:"label,omitempty"`
	// An upload link's (see shareLink)
	Upload   bool  `json:"upload,omitempty"`
	MaxBytes int64 `json:"max_bytes,omitempty"`
	Bytes    int64 `json:"bytes,omitempty"`
}

// list lists the live links, newest first, for the session with handle
// current.
func (s *shareStore) list(current string) []shareInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pruneLocked(s.clock.Now()) {
		s.saveLocked()
	}
	out := []shareInfo{}
	for _, l := range s.links {
		out = append(out, shareInfo{l.handle(), l.Path, l.Dir, l.Created, l.Expires, l.Max, l.Count, l.ByIP,
			l.By == current, append([]shareUse{}, l.Uses...), l.Sealed != "", l.Label, l.Upload, l.MaxBytes, l.Bytes})
	}
	slices.SortFunc(out, func(a, b shareInfo) int { return b.Created.Compare(a.Created) })
	return out
}

// shareRequest splits what follows filesPrefix into a link's token and
// name, if it's a link: the token, then at most a name.
func shareRequest(rest string) (token, name string, ok bool) {
	token, name, _ = strings.Cut(rest, "/")
	return token, name, shareToken.MatchString(token) && !strings.Contains(name, "/")
}

// serveShare answers a request for the link with token, with name what
// follows it in the path. A browser asking for a download link gets a page
// with a Download button (see downloadPage), which posts back here: that
// counts the download, and sends the browser on to the link with a ticket
// (see ticket) that fetches the file without counting it again. Anything
// else gets the file, and counts as a download. HEAD tells about the file,
// and doesn't count.
func (g *server) serveShare(w http.ResponseWriter, r *http.Request, token, name string) {
	h := w.Header()
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Vary", "Accept")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	page := wantsPage(r)
	ip := g.clientIP(r)
	l, limited := g.shares.lookup(token, ip)
	if limited {
		shareFail(w, page, http.StatusTooManyRequests, "Too many requests for links that don't exist. Try again later.")
		return
	}
	gone := func() { shareFail(w, page, http.StatusNotFound, "This link doesn't exist, or has ended.") }
	if l == nil && page && name == "" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		// /fs/<name>/ is a folder's address as well as an upload link's:
		// said so, the same whether there's such a folder or not, so it
		// tells nothing of what's in Downloads.
		renderSharePage(w, http.StatusNotFound, sharePage{Title: "Link not available", Heading: "This link can't be used",
			Error: "This link doesn't exist, or has ended.", Folder: token, FolderURL: g.abs(filesPrefix) + "#/" + escapePath(token)})
		return
	}
	usedUp := func() {
		shareFail(w, page, http.StatusGone, "This link has been downloaded as many times as it allows.")
	}
	if l == nil {
		gone()
		return
	}
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		gone()
		return
	}
	defer store.Close()
	f, st, err := store.open(l.Path)
	if err != nil {
		gone()
		return
	}
	defer f.Close()
	if !l.matches(st) {
		gone()
		return
	}
	if l.Upload {
		g.serveUploadLink(w, r, l, store, name, page, ip)
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead, http.MethodPost:
	default:
		h.Set("Allow", "GET, HEAD, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if r.Method == http.MethodPost {
		// The page's Download button.
		if g.shares.use(l, ip, false) != nil {
			usedUp()
			return
		}
		g.logShareUse(l, ip)
		// Relative, so it keeps the link's path, under any base path.
		h.Set("Location", "?t="+g.shares.ticket(l, ip))
		w.WriteHeader(http.StatusSeeOther)
		return
	}
	ticketed := g.shares.redeem(l, r.URL.Query().Get("t"), ip)
	if page && !ticketed && r.Method == http.MethodGet {
		if n := g.shares.now(l); n.Max > 0 && n.Count >= n.Max {
			usedUp()
			return
		}
		renderSharePage(w, http.StatusOK, g.downloadPage(l, st.Size()))
		return
	}

	name = l.name()
	if l.Dir {
		name += ".zip"
	}
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	if l.Dir {
		h.Set("Content-Type", "application/zip")
	} else {
		h.Set("Content-Type", "application/octet-stream") // so ServeContent doesn't guess one
	}
	if r.Method == http.MethodHead {
		if !l.Dir {
			http.ServeContent(w, r, name, st.ModTime(), f)
		}
		return
	}
	// A ticket's download was counted when it was given.
	resume := ticketed || !l.Dir && startsPartWay(r.Header.Get("Range"))
	// So many at once from each address, and all told; each cut off if
	// it's not taken (see stallWriter). Refused, it's not counted.
	done, ok := g.shares.startDownload(ip)
	if !ok {
		shareFail(w, page, http.StatusServiceUnavailable, "Too many downloads are going at once. Try again in a little while.")
		return
	}
	defer done()
	// Counted only as the file starts to go: not for an answer without it,
	// as "not modified" to a client that has it already.
	cw := &countOnSend{ResponseWriter: stallWriter{w, http.NewResponseController(w)},
		count: func() bool {
			if g.shares.use(l, ip, resume) != nil {
				return false
			}
			if !resume {
				g.logShareUse(l, ip)
			}
			return true
		},
		refuse: func(w http.ResponseWriter) {
			shareFail(w, page, http.StatusGone, "This link has been downloaded as many times as it allows.")
		}}
	w = cw
	if !l.Dir {
		http.ServeContent(w, r, name, st.ModTime(), revocableFile{f, l})
		if l.Once && cw.whole() {
			// Done with: not left listed till it ends.
			g.revokeShares(func(o *shareLink) bool { return o == l })
		}
		return
	}
	// A zip is counted before it starts, so one refused isn't cut off.
	if cw.WriteHeader(http.StatusOK); cw.refused {
		return
	}
	zw := zip.NewWriter(revocableWriter{w, l})
	z := &zipper{store: store, zw: zw}
	f.Close() // the zipper opens it again, checking it's the same folder
	err = z.addDir(l.Path, l.name(), st, 1)
	if err == nil {
		err = zw.Close()
	}
	if err != nil {
		// Cut it off, rather than end it as a zip that looks complete.
		panic(http.ErrAbortHandler)
	}
}

// shareLabel checks a link's label, and returns it trimmed.
func shareLabel(s string) (string, bool) {
	s = strings.TrimSpace(s)
	return s, utf8.ValidString(s) && utf8.RuneCountInString(s) <= maxLabel && !strings.ContainsFunc(s, unicode.IsControl)
}

// The longest a link's label may be, in characters.
const maxLabel = 100

// labelText is a link's label, quoted, for the activity log, if it has
// one.
// (s.mu held: it can be changed meanwhile; see labelQuote.)
func labelText(l *shareLink) string {
	if l.Label == "" {
		return ""
	}
	return fmt.Sprintf(" (%q)", l.Label)
}

// labelQuote is labelText, for a label known without the lock (as one
// just set).
func labelQuote(label string) string {
	if label == "" {
		return ""
	}
	return fmt.Sprintf(" (%q)", label)
}

// linkKind and linkTarget name a link, and what it's to, in the activity
// log.
func linkKind(l *shareLink) string {
	if l.Upload {
		return "upload link"
	}
	return "share link"
}

func linkTarget(l *shareLink) string {
	if l.Upload || l.Dir {
		return folderText(l.Path)
	}
	return l.Path
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func maxText(n int) string {
	if n == 0 {
		return "no limit"
	}
	return fmt.Sprint(n)
}

// startsPartWay reports whether a Range header asks for anything but the
// file from its start: a download carrying on, which doesn't count again.
//
// Only one range: one of several isn't a download carrying on, and Go's
// ServeContent sends the whole file for ranges that add up to more than
// it, which would be a whole download, uncounted.
func startsPartWay(rng string) bool {
	spec, ok := strings.CutPrefix(strings.TrimSpace(rng), "bytes=")
	if !ok || strings.Contains(spec, ",") {
		return false
	}
	start, _, _ := strings.Cut(strings.TrimSpace(spec), "-")
	return strings.TrimLeft(start, "0") != ""
}

// revocableFile and revocableWriter stop a download as soon as its link is
// revoked.
type revocableFile struct {
	*os.File
	l *shareLink
}

var errShareRevoked = errors.New("the link was revoked")

func (f revocableFile) Read(p []byte) (int, error) {
	if f.l.revoked.Load() {
		return 0, errShareRevoked
	}
	return f.File.Read(p)
}

type revocableWriter struct {
	w io.Writer
	l *shareLink
}

func (w revocableWriter) Write(p []byte) (int, error) {
	if w.l.revoked.Load() {
		return 0, errShareRevoked
	}
	return w.w.Write(p)
}

// logShareUse logs a download of l by ip, in the log and the activity log,
// as often as logUse says.
func (g *server) logShareUse(l *shareLink, ip string) {
	if !g.shares.logUse(l, ip) {
		return
	}
	n := g.shares.now(l)
	log.Printf("share link to %q downloaded from %s (%d of %s)", l.Path, ip, n.Count, maxText(n.Max))
	g.activity.add("share-used", ip, "downloaded %s through a share link %s", linkTarget(l), usedText(n.Count, n.Max))
}

// Downloads through links going at once, from any one address, and all
// told.
const (
	maxShareDownloadsPerAddress = 8
	maxShareDownloads           = 256
)

// startDownload takes a place for a download through a link from ip, and
// returns what gives it back; ok is false if there's none.
func (s *shareStore) startDownload(ip string) (done func(), ok bool) {
	key := limitKey(ip)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.downloads == nil {
		s.downloads = map[string]int{}
	}
	if s.downloads[key] >= maxShareDownloadsPerAddress || s.downloadsAll >= maxShareDownloads {
		return nil, false
	}
	s.downloads[key]++
	s.downloadsAll++
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.downloads[key]--; s.downloads[key] <= 0 {
			delete(s.downloads, key)
		}
		s.downloadsAll--
	}, true
}

// stallWriter cuts a download off if the client stops taking it: each
// write must be taken within fileStall, as each piece of an upload must
// come (see stallReader).
type stallWriter struct {
	http.ResponseWriter
	rc *http.ResponseController
}

// shareStall is how long that is; tests make it shorter.
var shareStall = fileStall

func (s stallWriter) Write(p []byte) (int, error) {
	s.rc.SetWriteDeadline(time.Now().Add(shareStall))
	return s.ResponseWriter.Write(p)
}

// countOnSend counts a download through a link (with count) only once the
// file starts to go: an answer of 200 or 206. Any other (304 Not Modified,
// 412, 416) isn't one. If it can't be counted (the link used up meanwhile),
// refuse answers instead, and what follows is dropped.
type countOnSend struct {
	http.ResponseWriter
	count   func() bool
	refuse  func(http.ResponseWriter)
	decided bool
	refused bool
	code    int  // what was answered
	failed  bool // a write failed: the file didn't all go
}

// whole reports whether the whole file was sent (200, every write taken).
func (c *countOnSend) whole() bool {
	return c.decided && !c.refused && !c.failed && c.code == http.StatusOK
}

func (c *countOnSend) WriteHeader(code int) {
	if c.decided {
		if !c.refused {
			c.ResponseWriter.WriteHeader(code)
		}
		return
	}
	c.decided = true
	c.code = code
	if (code == http.StatusOK || code == http.StatusPartialContent) && !c.count() {
		c.refused = true
		h := c.ResponseWriter.Header()
		for _, k := range []string{"Content-Length", "Content-Range", "Content-Disposition", "Content-Type", "Content-Encoding",
			"Accept-Ranges", "Last-Modified", "Etag"} {
			h.Del(k)
		}
		c.refuse(c.ResponseWriter)
		return
	}
	c.ResponseWriter.WriteHeader(code)
}

func (c *countOnSend) Write(p []byte) (int, error) {
	if !c.decided {
		c.WriteHeader(http.StatusOK)
	}
	if c.refused {
		return 0, errShareUsedUp
	}
	n, err := c.ResponseWriter.Write(p)
	if err != nil {
		c.failed = true
	}
	return n, err
}

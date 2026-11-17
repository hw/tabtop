package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/pbkdf2"
)

// bootstrapPage is the offline pack decoder (scripts/bootstrap), served as
// text/plain so a client can save it and open it from disk after checking the
// passcode/hash out of band.
//
//go:embed bootstrap.html
var bootstrapPage string

// bootstrapClientJSON is the embedded tabtop-pack/v1 tree (build artifact).
// tabtopd seals only its tabtop.html (after ASSETS injection when
// -offline-client) each calendar day with a fresh passcode for /auth/pack.
// Built by scripts/bootstrap/build-full-client.mjs.
//
//go:embed bootstrap.client.json
var bootstrapClientJSON []byte

const bootstrapPBKDF2Iter = 210000

// bootstrapDecoderHash is the SHA-256 hex of bootstrap.html (/auth/bootstrap),
// set at link time (-X main.bootstrapDecoderHash=…, as the Dockerfile and
// mise build do) for out-of-band comparison after download. Empty if unset.
var bootstrapDecoderHash string

// bootstrapDecoderSHA256 is the stamped decoder hash, or "".
func bootstrapDecoderSHA256() string {
	return strings.TrimSpace(bootstrapDecoderHash)
}

// bootstrapState holds today's sealed pack and its OOB passcode.
type bootstrapState struct {
	mu         sync.Mutex
	day        string // YYYY-MM-DD in the server's TZ
	pass       string
	pack       string // JSON object + trailing newline, as served
	hash       string // SHA-256 hex of pack
	clientHash string // SHA-256 hex of sealed plaintext (tabtop.html)
}

// bootstrap serves the offline decoder as plain text, or today's sealed client
// pack as JSON, under the site base. Both need no login: they are meant to be
// fetched, verified OOB, then used locally.
func (g *server) bootstrap(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	// Public on purpose: the pack is sealed; authenticity is the OOB hash + passcode.
	h.Set("Access-Control-Allow-Origin", "*")
	switch r.URL.Path {
	case "/auth/bootstrap", "/auth/pack":
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodOptions {
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body := bootstrapPage
	ct := "text/plain; charset=utf-8"
	if r.URL.Path == "/auth/pack" {
		pack, _, err := g.ensureBootstrapPack()
		if err != nil {
			log.Printf("bootstrap pack: %v", err)
			http.Error(w, "bootstrap pack unavailable", http.StatusServiceUnavailable)
			return
		}
		body = pack
		ct = "application/json"
		h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
			"filename": "tabtop-client.pack.json",
		}))
	}
	h.Set("Content-Type", ct)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		return
	}
	io.WriteString(w, body)
}

// bootstrapInfo returns today's pack passcode, pack SHA-256, and tabtop.html
// SHA-256 (regenerating the pack when the calendar day in the server's TZ
// has changed).
func (g *server) bootstrapInfo() (pass, packHash, clientHash string) {
	_, pass, packHash, clientHash, err := g.bootstrapSnapshot(false)
	if err != nil {
		log.Printf("bootstrap pack: %v", err)
		return "", "", ""
	}
	return pass, packHash, clientHash
}

func (g *server) ensureBootstrapPack() (pack, pass string, err error) {
	pack, pass, _, _, err = g.bootstrapSnapshot(false)
	return pack, pass, err
}

// resealBootstrapPack seals a new pack with a fresh passcode, even on the
// same calendar day (for the Sessions page control).
func (g *server) resealBootstrapPack() (pass, packHash, clientHash string, err error) {
	_, pass, packHash, clientHash, err = g.bootstrapSnapshot(true)
	return pass, packHash, clientHash, err
}

func (g *server) bootstrapSnapshot(force bool) (pack, pass, hash, clientHash string, err error) {
	day := g.bootstrapDay(g.clock.Now())
	g.bootPack.mu.Lock()
	defer g.bootPack.mu.Unlock()
	if !force && g.bootPack.day == day && g.bootPack.pack != "" {
		return g.bootPack.pack, g.bootPack.pass, g.bootPack.hash, g.bootPack.clientHash, nil
	}
	pass, err = randomBootstrapPasscode()
	if err != nil {
		return "", "", "", "", err
	}
	plain, err := g.offlineClientPlain()
	if err != nil {
		return "", "", "", "", err
	}
	sum := sha256.Sum256(plain)
	clientHash = hex.EncodeToString(sum[:])
	pack, hash, err = sealBootstrapPack(plain, pass)
	if err != nil {
		return "", "", "", "", err
	}
	g.bootPack.day = day
	g.bootPack.pass = pass
	g.bootPack.pack = pack
	g.bootPack.hash = hash
	g.bootPack.clientHash = clientHash
	log.Printf("bootstrap pack sealed for %s (pack sha256 %s, tabtop.html sha256 %s)", day, hash, clientHash)
	return pack, pass, hash, clientHash, nil
}

func (g *server) bootstrapDay(now time.Time) string {
	name := g.timeZone
	if name == "" {
		name = "UTC"
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		loc = time.UTC
	}
	return now.In(loc).Format("2006-01-02")
}

// startBootstrapRotation reseals the pack when the calendar day changes.
func (g *server) startBootstrapRotation() {
	go func() {
		// First seal is lazy (on download or sessions page); only watch the day.
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for range t.C {
			if _, _, err := g.ensureBootstrapPack(); err != nil {
				log.Printf("bootstrap pack rotation: %v", err)
			}
		}
	}()
}

type bootstrapPackJSON struct {
	V    int    `json:"v"`
	KDF  string `json:"kdf"`
	Iter int    `json:"iter"`
	Salt string `json:"salt"`
	IV   string `json:"iv"`
	CT   string `json:"ct"`
}

func sealBootstrapPack(plain []byte, pass string) (packText, hashHex string, err error) {
	salt := make([]byte, 16)
	iv := make([]byte, 12)
	if _, err = rand.Read(salt); err != nil {
		return "", "", err
	}
	if _, err = rand.Read(iv); err != nil {
		return "", "", err
	}
	key := pbkdf2.Key([]byte(pass), salt, bootstrapPBKDF2Iter, 32, sha256.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", err
	}
	ct := gcm.Seal(nil, iv, plain, nil)
	b64 := base64.StdEncoding.EncodeToString
	raw, err := json.Marshal(bootstrapPackJSON{
		V: 1, KDF: "PBKDF2-SHA256", Iter: bootstrapPBKDF2Iter,
		Salt: b64(salt), IV: b64(iv), CT: b64(ct),
	})
	if err != nil {
		return "", "", err
	}
	packText = string(raw) + "\n"
	sum := sha256.Sum256([]byte(packText))
	return packText, hex.EncodeToString(sum[:]), nil
}

// randomBootstrapPasscode is a 120-bit secret as lower-case base32 in groups,
// easy to read out of band (e.g. over a phone).
func randomBootstrapPasscode() (string, error) {
	var b [15]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	s := strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:]))
	if len(s) != 24 {
		return "", fmt.Errorf("unexpected passcode length %d", len(s))
	}
	return s[0:4] + "-" + s[4:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:24], nil
}

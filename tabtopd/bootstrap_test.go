package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/pbkdf2"
)

func TestBootstrapPackJSON(t *testing.T) {
	g, _ := newE2EServer(t)
	h := g.handler()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/bootstrap/pack", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q", ct)
	}
	body := w.Body.Bytes()
	var pack bootstrapPackJSON
	if err := json.Unmarshal(body, &pack); err != nil {
		t.Fatalf("json: %v", err)
	}
	if pack.V != 1 || pack.KDF != "PBKDF2-SHA256" || pack.Iter != bootstrapPBKDF2Iter ||
		pack.Salt == "" || pack.IV == "" || pack.CT == "" {
		t.Fatalf("pack fields: %+v", pack)
	}
	sum := sha256.Sum256(body)
	wantHash := hex.EncodeToString(sum[:])
	pass, hash := g.bootstrapInfo()
	if pass == "" || !strings.Contains(pass, "-") {
		t.Fatalf("passcode %q", pass)
	}
	if hash != wantHash {
		t.Fatalf("hash %q, want %q", hash, wantHash)
	}
	sumPage := sha256.Sum256([]byte(bootstrapPage))
	if got := bootstrapDecoderSHA256(); got != hex.EncodeToString(sumPage[:]) {
		t.Fatalf("decoder sha256 %q", got)
	}
}

func TestBootstrapPackRotatesDaily(t *testing.T) {
	g, _ := newE2EServer(t)
	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	g.clock = lifecycleClock{now: func() time.Time { return now }}
	pack1, pass1, err := g.ensureBootstrapPack()
	if err != nil {
		t.Fatal(err)
	}
	pack1b, pass1b, err := g.ensureBootstrapPack()
	if err != nil {
		t.Fatal(err)
	}
	if pack1 != pack1b || pass1 != pass1b {
		t.Fatal("same day should keep the pack and passcode")
	}
	now = now.Add(24 * time.Hour)
	pack2, pass2, err := g.ensureBootstrapPack()
	if err != nil {
		t.Fatal(err)
	}
	if pack2 == pack1 || pass2 == pass1 {
		t.Fatal("next day should reseal with a new passcode")
	}
}

func TestBootstrapResealSameDay(t *testing.T) {
	g, _ := newE2EServer(t)
	_, pass1, err := g.ensureBootstrapPack()
	if err != nil {
		t.Fatal(err)
	}
	pass2, hash2, err := g.resealBootstrapPack()
	if err != nil {
		t.Fatal(err)
	}
	if pass2 == pass1 || hash2 == "" {
		t.Fatal("reseal should mint a new passcode")
	}
	pass3, hash3 := g.bootstrapInfo()
	if pass3 != pass2 || hash3 != hash2 {
		t.Fatal("info should match the resealed pack")
	}
}

func TestSealBootstrapPackRoundTrip(t *testing.T) {
	plain := []byte(`{"format":"tabtop-client/v1","name":"t","files":{"a.txt":"hi"}}`)
	packText, hash, err := sealBootstrapPack(plain, "test-pass-code")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(packText))
	if hex.EncodeToString(sum[:]) != hash {
		t.Fatal("hash mismatch")
	}
	var pack bootstrapPackJSON
	if err := json.Unmarshal([]byte(packText), &pack); err != nil {
		t.Fatal(err)
	}
	salt, err := base64.StdEncoding.DecodeString(pack.Salt)
	if err != nil {
		t.Fatal(err)
	}
	iv, err := base64.StdEncoding.DecodeString(pack.IV)
	if err != nil {
		t.Fatal(err)
	}
	ct, err := base64.StdEncoding.DecodeString(pack.CT)
	if err != nil {
		t.Fatal(err)
	}
	key := pbkdf2.Key([]byte("test-pass-code"), salt, pack.Iter, 32, sha256.New)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	got, err := gcm.Open(nil, iv, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(plain) {
		t.Fatalf("plain %q", got)
	}
}

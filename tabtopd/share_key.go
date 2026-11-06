package main

// Showing a link again: each link's token is kept in -shares-file sealed
// (XChaCha20-Poly1305, with the link's ID as associated data), under a key
// in another file, -share-key-file, so Share links can show a
// link again after the dialog that made it has closed (see shareLinkAgain).
// The shares file alone, as in a backup or a copy sent with a question,
// holds no link anyone can use; someone who can read both files can use
// them all, as the desktop user can anyway, being able to make links.
// Without a key file, the key lasts as long as the gateway, and links made
// before a restart can't be shown again, though they still work.

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io/fs"
	"log"
	"os"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
)

// loadShareKey reads the key in file, making one there if there isn't one.
// One it can't read (as when it's briefly unreadable) is left as it is,
// for the next start, and a key used till then; one that isn't a key is
// set aside, not overwritten.
func loadShareKey(file string) []byte {
	key, err := os.ReadFile(file)
	if err == nil && len(key) == chacha20poly1305.KeySize {
		return key
	}
	switch {
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		log.Printf("share links: reading %s: %v; left as it is, and links made before can't be shown again till it can be read", file, err)
		return newShareKey()
	case err == nil:
		aside, aerr := setAside(file)
		if aerr != nil {
			log.Printf("share links: %s isn't a key, and can't be set aside (%v); left as it is", file, aerr)
			return newShareKey()
		}
		log.Printf("share links: %s isn't a key; set aside as %s, and a new one made, so links made before can't be shown again", file, aside)
	}
	key = newShareKey()
	if err := writeFileAtomic(file, key); err != nil {
		log.Printf("share links: saving the key: %v; links made from now are shown again only until a restart", err)
	}
	return key
}

func newShareKey() []byte {
	key := make([]byte, chacha20poly1305.KeySize)
	rand.Read(key)
	return key
}

// seal is token, sealed for the link with id.
func (s *shareStore) seal(id, token string) string {
	aead, _ := chacha20poly1305.NewX(s.key)
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	return base64.RawStdEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(token), []byte(id)))
}

var errShareNotShown = errors.New("This link can't be shown again: it was made before links were kept to show, or its key has changed. It still works; make another to send.")

// token is l's token, unsealed.
func (s *shareStore) token(l *shareLink) (string, error) {
	sealed, err := base64.RawStdEncoding.DecodeString(l.Sealed)
	aead, _ := chacha20poly1305.NewX(s.key)
	if err != nil || len(sealed) < aead.NonceSize() {
		return "", errShareNotShown
	}
	token, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], []byte(l.ID))
	if err != nil {
		return "", errShareNotShown
	}
	return string(token), nil
}

// folderOrPath names what a reply of shareLinkAgain's is to, for the
// activity log.
func folderOrPath(reply map[string]any) string {
	p, _ := reply["path"].(string)
	if reply["upload"] == true || reply["dir"] == true {
		return folderText(p)
	}
	return p
}

// shareLinkAgain is the link with handle's token, and what the page needs
// to make its address.
func (s *shareStore) shareLinkAgain(handle string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.links {
		if l.handle() == handle && s.clock.Now().Before(l.Expires) {
			token, err := s.token(l)
			if err != nil {
				return nil, err
			}
			return map[string]any{"token": token, "name": l.name(), "dir": l.Dir, "upload": l.Upload, "path": l.Path}, nil
		}
	}
	return nil, errors.New("That link has ended already.")
}

// setAside renames file to show it's not what it should be, beside it, so
// what it holds isn't lost when a new one is written, and returns its new
// name.
func setAside(file string) (string, error) {
	aside := file + ".broken-" + time.Now().UTC().Format("20060102-150405")
	return aside, os.Rename(file, aside)
}

package main

// CPace, the password-authenticated key exchange the tunnel's login uses
// (draft-irtf-cfrg-cpace, on X25519 with SHA-512). Both sides turn the
// password into a curve point, the generator, and run X25519 from it:
// matching passwords give matching keys, and a recording of the exchange
// is no help in guessing the password offline. Someone who takes part in
// the exchange gets one guess per generator.
//
// The password here is the login credential, pam_oath PIN + TOTP code. The
// server doesn't know which of the codes for the previous, current and next
// 30 s the browser has, so it runs one exchange per candidate (see
// loginTunnel), and the browser's key confirmation tells it which matched.

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	cpaceDSI = "CPace255"
	cpaceCI  = "tabtop login" // channel identifier
	cpaceSID = 16             // session id length, chosen by the browser
)

var (
	curveP = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	curveA = big.NewInt(486662)
)

// elligator2 maps a field element to the u-coordinate of a point on
// Curve25519 (RFC 9380 section 6.7.1, with Z = 2). It isn't constant time;
// its input is a hash that includes the browser's random session id, so
// timing reveals nothing that carries over to another login.
func elligator2(r *big.Int) *big.Int {
	p := curveP
	tv1 := new(big.Int).Mul(r, r)
	tv1.Lsh(tv1, 1).Mod(tv1, p) // Z * r^2
	if new(big.Int).Add(tv1, big.NewInt(1)).Cmp(p) == 0 {
		tv1.SetInt64(0) // Z * r^2 == -1: the exceptional case
	}
	den := new(big.Int).Add(tv1, big.NewInt(1))
	den.ModInverse(den, p)
	x1 := new(big.Int).Neg(curveA)
	x1.Mul(x1, den).Mod(x1, p)
	// gx1 = x1^3 + A x1^2 + x1
	gx1 := new(big.Int).Add(x1, curveA)
	gx1.Mul(gx1, x1).Add(gx1, big.NewInt(1)).Mul(gx1, x1).Mod(gx1, p)
	if isSquare(gx1) {
		return x1
	}
	x2 := new(big.Int).Neg(x1)
	x2.Sub(x2, curveA).Mod(x2, p)
	return x2
}

func isSquare(x *big.Int) bool {
	e := new(big.Int).Rsh(new(big.Int).Sub(curveP, big.NewInt(1)), 1)
	l := new(big.Int).Exp(x, e, curveP)
	return l.Sign() == 0 || l.Cmp(big.NewInt(1)) == 0
}

// lv is CPace's prepend_len: a LEB128 length, then the data.
func lv(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = binary.AppendUvarint(out, uint64(len(p)))
		out = append(out, p...)
	}
	return out
}

// cpaceGenerator is the generator for a password: the hash of the
// password and the session id, mapped onto the curve, as 32 little-endian
// bytes.
func cpaceGenerator(prs string, sid []byte) []byte {
	zpad := max(0, 128-len(lv([]byte(prs)))-len(lv([]byte(cpaceDSI)))-1)
	h := sha512.Sum512(lv([]byte(cpaceDSI), []byte(prs), make([]byte, zpad), []byte(cpaceCI), sid))
	le := h[:32]
	le[31] &= 0x7f
	r := new(big.Int).SetBytes(reversed(le))
	u := elligator2(r.Mod(r, curveP))
	return reversed(u.FillBytes(make([]byte, 32)))
}

func reversed(b []byte) []byte {
	out := slices.Clone(b)
	slices.Reverse(out)
	return out
}

// cpaceShare picks a secret scalar and returns it with its public share,
// X25519(scalar, generator).
func cpaceShare(gen []byte) (*ecdh.PrivateKey, []byte, error) {
	y, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	share, err := x25519(y, gen)
	return y, share, err
}

// x25519 is X25519(scalar, u); it fails if the result is all zeros.
func x25519(y *ecdh.PrivateKey, u []byte) ([]byte, error) {
	pub, err := ecdh.X25519().NewPublicKey(u)
	if err != nil {
		return nil, err
	}
	return y.ECDH(pub)
}

// cpaceISK is the shared secret from the exchange, bound to the session id
// and both shares.
func cpaceISK(sid, k, ya, yb []byte) []byte {
	h := sha512.Sum512(append(lv([]byte(cpaceDSI+"_ISK"), sid, k), lv(ya, nil, yb, nil)...))
	return h[:]
}

// oathEntry is the first line of the pam_oath users file.
type oathEntry struct {
	user, pin string // pin is "" when the file has "-"
	key       []byte
	digits    int
}

func readOathEntry(usersFile string) (oathEntry, error) {
	data, err := os.ReadFile(usersFile)
	if err != nil {
		return oathEntry{}, err
	}
	line, _, _ := strings.Cut(string(data), "\n")
	f := strings.Fields(line)
	if len(f) < 4 {
		return oathEntry{}, fmt.Errorf("cannot parse %s", usersFile)
	}
	digits, err := strconv.Atoi(f[0][strings.LastIndex(f[0], "/")+1:])
	if err != nil || digits < 6 || digits > 8 {
		return oathEntry{}, fmt.Errorf("cannot parse %s", usersFile)
	}
	key, err := hex.DecodeString(f[3])
	if err != nil {
		return oathEntry{}, fmt.Errorf("cannot parse %s: %w", usersFile, err)
	}
	e := oathEntry{user: f[1], pin: f[2], key: key, digits: digits}
	if e.pin == "-" {
		e.pin = ""
	}
	return e, nil
}

// candidates are the credentials the browser may hold now: the PIN and the
// code for each 30 s step pam_oath accepts (window=1).
func (e oathEntry) candidates(now time.Time) []string {
	step := now.Unix() / 30
	var out []string
	for d := int64(-totpWindow); d <= totpWindow; d++ {
		out = append(out, e.pin+hotp(e.key, step+d, e.digits))
	}
	return out
}

// hotp computes an RFC 4226 one-time password; TOTP feeds it the time step.
func hotp(key []byte, counter int64, digits int) string {
	mac := hmac.New(sha1.New, key)
	binary.Write(mac, binary.BigEndian, counter)
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0F
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7FFFFFFF
	mod := uint32(1)
	for range digits {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%mod)
}

// sha256Sum is a helper for the session tunnel's transcript.
func sha256Sum(parts ...[]byte) []byte {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

// parseUsersOath reads the user and code length from the first line,
// "HOTP/T30/<digits> <user> <pin> <hex key> [last use...]".
func parseUsersOath(data string) (user string, digits int, ok bool) {
	line, _, _ := strings.Cut(data, "\n")
	fields := strings.Fields(line)
	if len(fields) < 4 {
		return "", 0, false
	}
	digits, err := strconv.Atoi(fields[0][strings.LastIndex(fields[0], "/")+1:])
	if err != nil || digits < 6 || digits > 8 {
		return "", 0, false
	}
	return fields[1], digits, true
}

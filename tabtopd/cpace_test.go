package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/sha512"
	"encoding/hex"
	"testing"
)

// The test vectors for CPace on X25519 with SHA-512, from appendix B.1 of
// draft-irtf-cfrg-cpace-21. TestCPace and the JavaScript interop test only
// show that both sides agree; these show that what they agree on is CPace.
const (
	cpaceVecPRS       = "Password"
	cpaceVecCI        = "\x0bA_initiator\x0bB_responder"
	cpaceVecSID       = "7e4b4791d6a8ef019b936c79fb7f2c57"
	cpaceVecGenString = "0843506163653235350850617373776f72646d000000000000000000" +
		"00000000000000000000000000000000000000000000000000000000" +
		"00000000000000000000000000000000000000000000000000000000" +
		"00000000000000000000000000000000000000000000000000000000" +
		"00000000000000000000000000000000180b415f696e69746961746f" +
		"720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f" +
		"2c57"
	cpaceVecGenHash = "03998087bdb1a2617bbe25ef5a7c18cd4f84f902328701790958755ee4aed1d3"
	cpaceVecG       = "d04bf6d41f6a289632a2e929fa29bebd51092512a7829fdde7d314b62f05a73f"
	cpaceVecYa      = "21b4f4bd9e64ed355c3eb676a28ebedaf6d8f17bdc365995b319097153044080"
	cpaceVecYaPub   = "1d13c89278cdadd826f6d8d7f887701430f8380ddc17611cdd6dc989ce0c9f32"
	cpaceVecYb      = "848b0779ff415f0af4ea14df9dd1d3c29ac41d836c7808896c4eba19c51ac40a"
	cpaceVecYbPub   = "248cccf6d5cdc3646f0ad593f9e6cef4e69d4945f8372e623512ecea32185623"
	cpaceVecK       = "5b067effbdc0b2a0e1d907b21ebb25cfedb96a852179a847c37e43ee71322c6b"
	cpaceVecISK     = "6e19b875f7a561d6b3ca3dbb9ef42ac55de3e717881018204b8922b4" +
		"d5e53bb2aa82c300bea7b65d2b671da71922ddf6472301b79bc270ad" +
		"fa8bf413285f2263"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestCPaceDraftVectors(t *testing.T) {
	sid := unhex(t, cpaceVecSID)

	// The generator string and its hash, as cpaceGeneratorCI builds them.
	zpad := max(0, 128-len(lv([]byte(cpaceVecPRS)))-len(lv([]byte(cpaceDSI)))-1)
	genStr := lv([]byte(cpaceDSI), []byte(cpaceVecPRS), make([]byte, zpad), []byte(cpaceVecCI), sid)
	if got := hex.EncodeToString(genStr); got != cpaceVecGenString {
		t.Fatalf("generator string\n got %s\nwant %s", got, cpaceVecGenString)
	}
	if h := sha512.Sum512(genStr); hex.EncodeToString(h[:32]) != cpaceVecGenHash {
		t.Fatalf("generator string hash = %x", h[:32])
	}
	g := cpaceGeneratorCI(cpaceVecPRS, cpaceVecCI, sid)
	if hex.EncodeToString(g) != cpaceVecG {
		t.Fatalf("generator = %x, want %s", g, cpaceVecG)
	}

	scalar := func(s string) *ecdh.PrivateKey {
		k, err := ecdh.X25519().NewPrivateKey(unhex(t, s))
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	ya, yb := scalar(cpaceVecYa), scalar(cpaceVecYb)
	Ya, err := x25519(ya, g)
	if err != nil || hex.EncodeToString(Ya) != cpaceVecYaPub {
		t.Fatalf("Ya = %x, %v", Ya, err)
	}
	Yb, err := x25519(yb, g)
	if err != nil || hex.EncodeToString(Yb) != cpaceVecYbPub {
		t.Fatalf("Yb = %x, %v", Yb, err)
	}
	ka, err := x25519(ya, Yb)
	if err != nil || hex.EncodeToString(ka) != cpaceVecK {
		t.Fatalf("K from A = %x, %v", ka, err)
	}
	kb, err := x25519(yb, Ya)
	if err != nil || !bytes.Equal(ka, kb) {
		t.Fatalf("K from B = %x, %v", kb, err)
	}
	isk := cpaceISKAD(sid, ka, Ya, []byte("ADa"), Yb, []byte("ADb"))
	if hex.EncodeToString(isk) != cpaceVecISK {
		t.Fatalf("ISK_IR = %x, want %s", isk, cpaceVecISK)
	}
	// What the tunnel uses: the same, with no associated data.
	if !bytes.Equal(cpaceISK(sid, ka, Ya, Yb), cpaceISKAD(sid, ka, Ya, nil, Yb, nil)) {
		t.Fatal("cpaceISK differs from cpaceISKAD without associated data")
	}
}

// The draft's low-order points (B.1.10) that scalar_mult_vfy must refuse:
// x25519 gives all zeros for them, which it reports as an error.
func TestCPaceLowOrderPoints(t *testing.T) {
	s, err := ecdh.X25519().NewPrivateKey(unhex(t, "af46e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449aff"))
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"0100000000000000000000000000000000000000000000000000000000000000",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
		"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	} {
		if k, err := x25519(s, unhex(t, u)); err == nil {
			t.Errorf("u = %s: accepted, K = %x", u, k)
		}
	}
}

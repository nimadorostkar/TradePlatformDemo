package mt5

import (
	"encoding/hex"
	"testing"
)

// TestSrvRandAnswer pins the MD5/UTF-16LE challenge chain to an independently
// computed vector (Python hashlib), guaranteeing bit-exact interop with the MT5
// Manager server. password="test", srv_rand="00112233445566778899aabbccddeeff".
func TestSrvRandAnswer(t *testing.T) {
	const (
		password = "test"
		srvRand  = "00112233445566778899aabbccddeeff"
		// MD5( MD5( MD5(utf16le("test")) ++ "WebAPI" ) ++ fromHex(srvRand) )
		wantAnswer   = "36616b988054a57d0e648d887f14ba1d"
		wantPassHash = "2f89076a25fc7dd5e68a1cc7471d13ae"
	)

	if got := hex.EncodeToString(passwordHash(password)); got != wantPassHash {
		t.Errorf("passwordHash = %s, want %s", got, wantPassHash)
	}

	got, err := srvRandAnswer(password, srvRand)
	if err != nil {
		t.Fatalf("srvRandAnswer: %v", err)
	}
	if got != wantAnswer {
		t.Errorf("srvRandAnswer = %s, want %s", got, wantAnswer)
	}
}

func TestSrvRandAnswerDeterministic(t *testing.T) {
	a, _ := srvRandAnswer("pw", "aabb")
	b, _ := srvRandAnswer("pw", "aabb")
	if a != b {
		t.Errorf("non-deterministic: %s != %s", a, b)
	}
	if len(a) != 32 {
		t.Errorf("answer length = %d, want 32 hex chars", len(a))
	}
}

func TestNewCliRand(t *testing.T) {
	a, err := newCliRand()
	if err != nil {
		t.Fatalf("newCliRand: %v", err)
	}
	if len(a) != 32 {
		t.Errorf("cli_rand length = %d, want 32 hex chars (16 bytes)", len(a))
	}
	b, _ := newCliRand()
	if a == b {
		t.Errorf("cli_rand not random: %s == %s", a, b)
	}
}

func TestUTF16LE(t *testing.T) {
	// "AB" → 0x41 0x00 0x42 0x00
	got := utf16leBytes("AB")
	want := []byte{0x41, 0x00, 0x42, 0x00}
	if hex.EncodeToString(got) != hex.EncodeToString(want) {
		t.Errorf("utf16leBytes(AB) = % x, want % x", got, want)
	}
}

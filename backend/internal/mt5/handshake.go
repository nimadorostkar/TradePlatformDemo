package mt5

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"unicode/utf16"
)

// authStartResponse is the JSON body of /api/auth/start.
type authStartResponse struct {
	Retcode string `json:"retcode"`
	SrvRand string `json:"srv_rand"`
}

// authAnswerResponse is the JSON body of /api/auth/answer.
type authAnswerResponse struct {
	Retcode       string `json:"retcode"`
	CliRandAnswer string `json:"cli_rand_answer"`
}

// passwordHash computes the MT5 Manager password hash:
//
//	MD5( MD5(UTF16LE(password)) ++ "WebAPI" )
//
// This is the MetaQuotes-defined derivation (see docs/ANALYSIS.md §7.2).
func passwordHash(password string) []byte {
	pwUTF16 := utf16leBytes(password)
	h1 := md5.Sum(pwUTF16)
	combined := append(h1[:], []byte("WebAPI")...)
	h2 := md5.Sum(combined)
	return h2[:]
}

// srvRandAnswer computes the auth/start challenge response:
//
//	lower_hex( MD5( passwordHash(password) ++ fromHex(srvRandHex) ) )
func srvRandAnswer(password, srvRandHex string) (string, error) {
	srv, err := hex.DecodeString(srvRandHex)
	if err != nil {
		return "", fmt.Errorf("decode srv_rand: %w", err)
	}
	ph := passwordHash(password)
	sum := md5.Sum(append(ph, srv...))
	return hex.EncodeToString(sum[:]), nil
}

// newCliRand returns 16 cryptographically-random bytes as lowercase hex,
// used as the client nonce in auth/answer. (The .NET version used a weak,
// time-seeded RNG; using crypto/rand here is an internal improvement with no
// observable effect — it is only a client-supplied nonce.)
func newCliRand() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate cli_rand: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// utf16leBytes encodes s as little-endian UTF-16 bytes (the encoding MT5 uses
// for password material).
func utf16leBytes(s string) []byte {
	u := utf16.Encode([]rune(s))
	out := make([]byte, len(u)*2)
	for i, r := range u {
		binary.LittleEndian.PutUint16(out[i*2:], r)
	}
	return out
}

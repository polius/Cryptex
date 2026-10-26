package crypto

import (
	"crypto/rand"
	_ "embed"
	"fmt"
	"math/big"
	"strings"
)

//go:embed eff_large_wordlist.txt
var wordlistRaw string

// Words is the EFF large wordlist (7776 words).
var Words = strings.Fields(wordlistRaw)

func randBelow(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return int(v.Int64())
}

// GeneratePassphrase returns 4 words from the EFF large wordlist plus a 2-digit number
// (about 54 bits), joined with hyphens, e.g. "copper-lantern-river-otter-42".
func GeneratePassphrase() string {
	parts := make([]string, 0, 5)
	for range 4 {
		parts = append(parts, Words[randBelow(len(Words))])
	}
	parts = append(parts, fmt.Sprintf("%02d", randBelow(100)))
	return strings.Join(parts, "-")
}

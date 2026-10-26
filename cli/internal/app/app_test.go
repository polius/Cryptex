package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/polius/cryptex/cli/internal/store"
)

func TestParseLink(t *testing.T) {
	l, err := ParseLink("https://vault.example/s/k7Qp2vR9mL#08hLdXPyTgClYg1aikN6PA")
	if err != nil || l.Base != "https://vault.example" || l.Kind != "s" || l.ID != "k7Qp2vR9mL" || l.Fragment != "08hLdXPyTgClYg1aikN6PA" || !l.HasFragment {
		t.Fatalf("%+v %v", l, err)
	}
	l, err = ParseLink("  https://h.example:8443/vault/q/7hk2Vn4pXa  ")
	if err != nil || l.Base != "https://h.example:8443/vault" || l.Kind != "q" || l.HasFragment {
		t.Fatalf("%+v %v", l, err)
	}
	for _, bad := range []string{"k7Qp2vR9mL", "https://vault.example/x/k7Qp2vR9mL#a", "https://vault.example/s/short#a", "ftp://h/s/k7Qp2vR9mL#a"} {
		if _, err := ParseLink(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestNormalizeServer(t *testing.T) {
	for in, want := range map[string]string{
		"vault.acme.com":                   "https://vault.acme.com",
		"https://vault.acme.com/":          "https://vault.acme.com",
		"https://vault.acme.com/api/v1/":   "https://vault.acme.com",
		"http://127.0.0.1:8000":            "http://127.0.0.1:8000",
		"https://acme.com/cryptex/api/v1":  "https://acme.com/cryptex",
		" https://vault.acme.com/tokens/ ": "https://vault.acme.com/tokens",
	} {
		if got, err := NormalizeServer(in); err != nil || got != want {
			t.Errorf("NormalizeServer(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestParseDuration(t *testing.T) {
	for in, want := range map[string]int64{"1h": 3600, "1d": 86400, "7d": 604800, "30m": 1800, "2w": 1209600, "1d12h": 129600, "600": 600, "90S": 90} {
		if got, err := ParseDuration(in); err != nil || got != want {
			t.Errorf("ParseDuration(%q) = %d, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "1y", "h", "1h x", "-1h"} {
		if _, err := ParseDuration(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestEnv(t *testing.T) {
	for in, want := range map[string]string{"DB_HOST": "DB_HOST", "Access key ID": "ACCESS_KEY_ID", "db.host": "DB_HOST", "2fa code": "_2FA_CODE", "!!!": "FIELD"} {
		if got := EnvKey(in); got != want {
			t.Errorf("EnvKey(%q) = %q", in, got)
		}
	}
	for in, want := range map[string]string{"plain": "plain", "": "", "a b": `"a b"`, `q"$x` + "\n": `"q\"\$x\n"`, "postgres://u:p@h/x?a=1": `"postgres://u:p@h/x?a=1"`, "postgres://u:p@h:5432/x": "postgres://u:p@h:5432/x"} {
		if got := EnvValue(in); got != want {
			t.Errorf("EnvValue(%q) = %q, want %q", in, got, want)
		}
	}
	got := FormatEnv([]OutItem{{T: "field", K: "Password", V: "x y"}, {T: "note", V: "A=1\nB=2"}, {T: "note", V: "hello there\nworld\n"}})
	if got != "Password=\"x y\"\nA=1\nB=2\n# hello there\n# world\n" {
		t.Fatalf("FormatEnv: %q", got)
	}
}

func TestFormatText(t *testing.T) {
	got := FormatText([]OutItem{{T: "note", V: "hi"}, {T: "field", K: "user", V: "sam"}, {T: "field", K: "Private key", V: "-----BEGIN X-----\nabc\n-----END X-----"}})
	want := "hi\nuser: sam\nPrivate key:\n-----BEGIN X-----\nabc\n-----END X-----\n"
	if got != want {
		t.Fatalf("FormatText: %q", got)
	}
}

func TestManifestJSON(t *testing.T) {
	b, err := json.Marshal(Manifest{V: 1, Items: []Item{
		{T: "field", K: "Host", V: "db-staging.internal:5432"},
		{T: "field", K: "Password", V: "k7#Qp2-vR9mL", Secret: true},
		{T: "file", Name: "vpn.ovpn", Type: "application/x-openvpn-profile", Size: 70, Stream: 1},
	}})
	if err != nil {
		t.Fatal(err)
	}
	// Byte-identical to the manifest in vectors.json.
	want := `{"v":1,"items":[{"t":"field","k":"Host","v":"db-staging.internal:5432","secret":false},{"t":"field","k":"Password","v":"k7#Qp2-vR9mL","secret":true},{"t":"file","name":"vpn.ovpn","type":"application/x-openvpn-profile","size":70,"stream":1}]}`
	if string(b) != want {
		t.Fatalf("manifest\n got %s\nwant %s", b, want)
	}
	nb, _ := json.Marshal(Item{T: "note", V: ""})
	if string(nb) != `{"t":"note","v":""}` {
		t.Fatalf("note: %s", nb)
	}
}

func TestAnswerItems(t *testing.T) {
	req := []string{"Access key ID", "Secret access key"}
	got := answerItems("access key id: A\nSECRET ACCESS KEY: B\nextra: C\n", req, false, false)
	want := []Item{{T: "field", K: "Access key ID", V: "A", Secret: true}, {T: "field", K: "Secret access key", V: "B", Secret: true}, {T: "field", K: "extra", V: "C"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	got = answerItems("ACCESS_KEY_ID=A\n", req, false, false)
	if got[0].K != "Access key ID" {
		t.Fatalf("env key match: %+v", got)
	}
	if got := answerItems("just text here", req, false, false); got[0].T != "note" {
		t.Fatalf("note: %+v", got)
	}
	if got := answerItems("s3cr3t value\n", []string{"Token"}, false, false); got[0].K != "Token" || got[0].V != "s3cr3t value" {
		t.Fatalf("single field: %+v", got)
	}
	if got := answerItems("a: 1\nb: 2", nil, false, false); got[0].T != "note" {
		t.Fatalf("no fields requested: %+v", got)
	}
	if got := answerItems("a: 1\nb: 2", nil, true, false); len(got) != 2 {
		t.Fatalf("--fields: %+v", got)
	}
}

func TestSafeName(t *testing.T) {
	for in, want := range map[string]string{"vpn.ovpn": "vpn.ovpn", "../../etc/passwd": "passwd", `..\..\x.txt`: "x.txt", "": "file-3", "..": "file-3", ".bashrc": "bashrc", "a\x00b": "a_b"} {
		if got := SafeName(in, 3); got != want {
			t.Errorf("SafeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFlagsAnywhere(t *testing.T) {
	a := &App{Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
	fs := a.flags("send", "", "")
	title := fs.String("title", "", "")
	pos, err := fs.parse([]string{"a.txt", "--title", "T", "b.txt", "--json", "--", "--c.txt"})
	if err != nil || *title != "T" || !a.json || !reflect.DeepEqual(pos, []string{"a.txt", "b.txt", "--c.txt"}) {
		t.Fatalf("%v %q %v", pos, *title, err)
	}
}

func TestStore(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CRYPTEX_CONFIG_DIR", dir)
	t.Setenv("CRYPTEX_KEYRING", "file")
	st, err := store.Open()
	if err != nil || st.Dir != dir {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "config.toml"), []byte("# mine\nserver = \"https://a.example\" # comment\nother = 'x'\n"), 0o600)
	cfg, err := st.Config()
	if err != nil || cfg["server"] != "https://a.example" || cfg["other"] != "x" {
		t.Fatalf("%v %v", cfg, err)
	}
	if err := st.SetConfig("server", "https://b.example"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "config.toml"))
	if !strings.Contains(string(b), "# mine\nserver = \"https://b.example\"\nother = 'x'") {
		t.Fatalf("config.toml: %q", b)
	}
	if _, err := st.SetToken("https://b.example", "cx_live_x"); err != nil {
		t.Fatal(err)
	}
	if tok, _ := st.Token("https://b.example"); tok != "cx_live_x" {
		t.Fatalf("token %q", tok)
	}
	if found, _ := st.DeleteToken("https://b.example"); !found {
		t.Fatal("token not found for delete")
	}
	if tok, _ := st.Token("https://b.example"); tok != "" {
		t.Fatal("token survived delete")
	}
	if err := st.SaveKey("k7Qp2vR9mL", []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(st.KeyPath("k7Qp2vR9mL"))
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", fi.Mode())
	}
	if k, _ := st.Key("k7Qp2vR9mL"); !bytes.Equal(k, []byte{1, 2, 3}) {
		t.Fatal("key round trip")
	}
	_ = st.DeleteKey("k7Qp2vR9mL")
	if k, _ := st.Key("k7Qp2vR9mL"); k != nil {
		t.Fatal("key survived delete")
	}
}

func TestFinalize(t *testing.T) {
	t.Setenv("CRYPTEX_CONFIG_DIR", t.TempDir())
	a := &App{Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
	st, _ := a.st()
	one, zero := 1, 0
	r := &store.Receipt{ID: "k7Qp2vR9mL", Kind: "secret", ManageToken: "m", Link: "https://x/s/k7Qp2vR9mL#k", Status: "waiting"}
	a.finalize(r, "opened", &one)
	if r.Link == "" {
		t.Fatal("link dropped while views are left")
	}
	a.finalize(r, "opened", &zero)
	if r.Link != "" {
		t.Fatal("link kept after the last view")
	}
	q := &store.Receipt{ID: "7hk2Vn4pXa", Kind: "request", ManageToken: "m", Link: "https://x/q/7hk2Vn4pXa#k", Status: "waiting"}
	_ = st.SaveKey(q.ID, []byte{1})
	a.finalize(q, "revealed", nil)
	if k, _ := st.Key(q.ID); k == nil || q.Link != "" {
		t.Fatal("answered request: link should go, key should stay until the answer is gone")
	}
	a.finalize(q, "expired", nil)
	if k, _ := st.Key(q.ID); k != nil {
		t.Fatal("key kept after expiry")
	}
}

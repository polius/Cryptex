package main

// End-to-end test against the real Python server. Skipped unless CRYPTEX_IT=1.
//
//	CRYPTEX_IT=1 go test ./cmd/cryptex -run Integration -v
//
// CRYPTEX_API_DIR points at the server checkout (default ../../../api, which needs .venv).

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/polius/cryptex/cli/internal/crypto"
)

type server struct {
	url  string
	data string
	cmd  *exec.Cmd
	log  *bytes.Buffer
}

// chunkFiles counts stored chunk blobs under DATA_DIR/chunks.
func (s *server) chunkFiles(t *testing.T) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(filepath.Join(s.data, "chunks"), func(_ string, d os.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			n++
		}
		return err
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return n
}

// metaStatus calls GET /secrets/{id}/meta with the reveal token derived from the link.
func metaStatus(t *testing.T, base, id, link string) int {
	t.Helper()
	K, err := crypto.ParseSecretFragment(link[strings.Index(link, "#")+1:])
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, base+"/api/v1/secrets/"+id+"/meta", nil)
	req.Header.Set("Authorization", "Reveal "+crypto.B64u(crypto.DeriveLink(id, K).RevealToken))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func startServer(t *testing.T, apiDir string, extra ...string) *server {
	t.Helper()
	port := freePort(t)
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	cmd := exec.Command(filepath.Join(apiDir, ".venv", "bin", "python"), "-m", "uvicorn", "cryptex.app:create_app",
		"--factory", "--host", "127.0.0.1", "--port", fmt.Sprint(port))
	cmd.Dir = apiDir
	data := t.TempDir()
	cmd.Env = append(os.Environ(), "DATA_DIR="+data, "SETUP_CODE=IT-CODE", "PUBLIC_URL="+url, "LOG_LEVEL=warning",
		"RATE_CREATE=1000/h", "RATE_REVEAL=1000/h", "RATE_FAILED_TOKENS=1000/h")
	cmd.Env = append(cmd.Env, extra...)
	var log bytes.Buffer
	cmd.Stdout, cmd.Stderr = &log, &log
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the server: %v", err)
	}
	s := &server{url: url, data: data, cmd: cmd, log: &log}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("server log (%s):\n%s", url, log.String())
		}
	})
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if r, err := http.Get(url + "/api/v1/healthz"); err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				return s
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("server didn't start:\n%s", log.String())
	return nil
}

// setup completes first-run setup over HTTP and returns an API token.
func setup(t *testing.T, base string) string {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	hc := &http.Client{Jar: jar}
	post := func(path, csrf string, body any) map[string]any {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, base+"/api/v1"+path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		if csrf != "" {
			req.Header.Set("X-CSRF", csrf)
		}
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		if resp.StatusCode >= 300 {
			t.Fatalf("POST %s: %d %v", path, resp.StatusCode, out)
		}
		return out
	}
	owner := post("/setup/owner", "", map[string]any{"setup_code": "IT-CODE", "email": "it@example.com", "name": "IT",
		"password": "a long password 123"})
	csrf, _ := owner["csrf"].(string)
	post("/setup/brand", csrf, map[string]any{"name": "IT"})
	post("/setup/access", csrf, map[string]any{"mode": "anyone"})
	tok := post("/me/tokens", csrf, map[string]any{"name": "it", "scopes": []string{"send", "request"}})
	token, _ := tok["token"].(string)
	if !strings.HasPrefix(token, "cx_live_") {
		t.Fatalf("token %v", tok)
	}
	return token
}

type cli struct {
	t   *testing.T
	bin string
	env []string
}

type result struct {
	out, err string
	code     int
}

func (c *cli) run(stdin string, args ...string) result {
	return c.runEnv(nil, stdin, args...)
}

func (c *cli) runEnv(env []string, stdin string, args ...string) result {
	c.t.Helper()
	cmd := exec.Command(c.bin, args...)
	cmd.Env = append(append(append([]string{}, os.Environ()...), c.env...), env...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		c.t.Fatal(err)
	}
	return result{out.String(), errb.String(), code}
}

func (c *cli) ok(stdin string, args ...string) string {
	c.t.Helper()
	r := c.run(stdin, args...)
	if r.code != 0 {
		c.t.Fatalf("cryptex %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), r.code, r.out, r.err)
	}
	return r.out
}

func (c *cli) code(want int, stdin string, args ...string) result {
	c.t.Helper()
	r := c.run(stdin, args...)
	if r.code != want {
		c.t.Fatalf("cryptex %s: exit %d, want %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), r.code, want, r.out, r.err)
	}
	return r
}

var linkRe = regexp.MustCompile(`^http://127\.0\.0\.1:\d+/([sq])/([0-9A-Za-z]{10})#([A-Za-z0-9_-]+)$`)

func link(t *testing.T, out string) (string, string) {
	t.Helper()
	l := strings.TrimSpace(out)
	m := linkRe.FindStringSubmatch(l)
	if m == nil {
		t.Fatalf("not a link: %q", out)
	}
	return l, m[2]
}

func jsonOut(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(s)), &m); err != nil {
		t.Fatalf("not JSON: %q: %v", s, err)
	}
	return m
}

func TestIntegration(t *testing.T) {
	if os.Getenv("CRYPTEX_IT") != "1" {
		t.Skip("set CRYPTEX_IT=1 to run against the real server")
	}
	apiDir := os.Getenv("CRYPTEX_API_DIR")
	if apiDir == "" {
		apiDir = "../../../api"
	}
	apiDir, _ = filepath.Abs(apiDir)
	if _, err := os.Stat(filepath.Join(apiDir, ".venv", "bin", "python")); err != nil {
		t.Fatalf("no server venv in %s: %v", apiDir, err)
	}
	tmp := t.TempDir()
	bin := filepath.Join(tmp, "cryptex")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	srv := startServer(t, apiDir)
	token := setup(t, srv.url)
	cfgDir := filepath.Join(tmp, "config")
	c := &cli{t: t, bin: bin, env: []string{"CRYPTEX_CONFIG_DIR=" + cfgDir, "CRYPTEX_KEYRING=file", "CRYPTEX_NO_PROMPT=1",
		"CRYPTEX_TOKEN=", "CRYPTEX_SERVER=", "CRYPTEX_PASSPHRASE="}}

	t.Run("login", func(t *testing.T) {
		c.t = t
		c.code(2, "cx_live_wrong", "login", srv.url, "--with-token")
		out := c.ok(token+"\n", "login", srv.url, "--with-token")
		if !strings.Contains(out, "it@example.com") {
			t.Fatalf("login output %q", out)
		}
		cfg, _ := os.ReadFile(filepath.Join(cfgDir, "config.toml"))
		if !strings.Contains(string(cfg), `server = "`+srv.url+`"`) {
			t.Fatalf("config.toml: %q", cfg)
		}
		fi, err := os.Stat(filepath.Join(cfgDir, "credentials.json"))
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("credentials.json: %v %v", fi, err)
		}
	})

	t.Run("send and open", func(t *testing.T) {
		c.t = t
		secret := "postgres password: k7#Qp2-vR9mL\nsecond line\n"
		r := c.run(secret, "send", "--title", "Staging database", "--ttl", "1d")
		if r.code != 0 || r.err != "" {
			t.Fatalf("send: %+v", r)
		}
		l, id := link(t, r.out)
		if strings.Contains(r.out, "k7#Qp2") {
			t.Fatal("send printed the secret")
		}
		st := jsonOut(t, c.ok("", "status", id, "--json"))
		if st["status"] != "waiting" || st["title"] != "Staging database" {
			t.Fatalf("status %v", st)
		}
		if n := srv.chunkFiles(t); n == 0 {
			t.Fatal("no chunk files stored before open")
		}
		if code := metaStatus(t, srv.url, id, l); code != 200 {
			t.Fatalf("meta before open: %d", code)
		}
		got := c.run("", "open", l)
		if got.code != 0 || got.out != secret {
			t.Fatalf("open: %+v", got)
		}
		// The CLI confirmed the read (DELETE /secrets/{id}/read), so the data is gone now, not after the grace.
		if code := metaStatus(t, srv.url, id, l); code != 410 {
			t.Fatalf("meta after open: %d, want 410", code)
		}
		if n := srv.chunkFiles(t); n != 0 {
			t.Fatalf("%d chunk files left on the server after a once-only open", n)
		}
		if !strings.Contains(got.err, "Staging database") || !strings.Contains(got.err, "from IT") {
			t.Fatalf("open header: %q", got.err)
		}
		r4 := c.code(4, "", "open", l)
		if !strings.Contains(r4.err, "already opened") {
			t.Fatalf("gone message: %q", r4.err)
		}
		st = jsonOut(t, c.ok("", "status", id, "--json"))
		if st["status"] != "opened" {
			t.Fatalf("status after open: %v", st)
		}
		// The link key is dropped from receipts once the status is final.
		rc, _ := os.ReadFile(filepath.Join(cfgDir, "receipts.json"))
		if strings.Contains(string(rc), l) {
			t.Fatal("receipts.json still holds the link of an opened secret")
		}
		if fi, _ := os.Stat(filepath.Join(cfgDir, "receipts.json")); fi.Mode().Perm() != 0o600 {
			t.Fatalf("receipts.json mode %v", fi.Mode())
		}
	})

	t.Run("files across chunks", func(t *testing.T) {
		c.t = t
		dir := t.TempDir()
		big := make([]byte, 11*1024*1024+123) // three chunks
		_, _ = rand.Read(big)
		bigPath := filepath.Join(dir, "big.bin")
		_ = os.WriteFile(bigPath, big, 0o600)
		emptyPath := filepath.Join(dir, "empty.txt")
		_ = os.WriteFile(emptyPath, nil, 0o600)
		l, _ := link(t, c.ok("note with files", "send", bigPath, emptyPath))
		out := filepath.Join(dir, "out")
		o := jsonOut(t, c.ok("", "open", l, "--out", out, "--as", "json"))
		items := o["items"].([]any)
		if len(items) != 3 || items[0].(map[string]any)["v"] != "note with files" {
			t.Fatalf("items %v", items)
		}
		got, err := os.ReadFile(filepath.Join(out, "big.bin"))
		if err != nil || sha256.Sum256(got) != sha256.Sum256(big) {
			t.Fatalf("big.bin differs (%d bytes, %v)", len(got), err)
		}
		if fi, err := os.Stat(filepath.Join(out, "empty.txt")); err != nil || fi.Size() != 0 {
			t.Fatalf("empty.txt: %v", err)
		}
	})

	t.Run("passphrase", func(t *testing.T) {
		c.t = t
		r := c.runEnv([]string{"CRYPTEX_PASSPHRASE=correct horse battery"}, "with a passphrase", "send", "--passphrase")
		if r.code != 0 {
			t.Fatalf("send: %+v", r)
		}
		l, _ := link(t, r.out)
		r5 := c.code(5, "", "open", l, "--passphrase", "wrong")
		if !strings.Contains(r5.err, "4 tries left") {
			t.Fatalf("wrong passphrase message: %q", r5.err)
		}
		j := c.code(5, "", "open", l, "--passphrase", "wrong again", "--json")
		if e := jsonOut(t, j.out)["error"].(map[string]any); e["code"] != "wrong_passphrase" || e["tries_left"] != 3.0 {
			t.Fatalf("json error %v", e)
		}
		c.code(1, "", "open", l) // no passphrase and no terminal: usage error, nothing consumed
		if got := c.ok("", "open", l, "--passphrase", "correct horse battery"); got != "with a passphrase" {
			t.Fatalf("open: %q", got)
		}

		// Generated passphrase: printed once to stderr, never to stdout.
		r = c.run("generated", "send", "--generate-passphrase")
		l, _ = link(t, r.out)
		m := regexp.MustCompile(`: ([a-z]+(?:-[a-z]+){3}-\d\d)\n`).FindStringSubmatch(r.err)
		if r.code != 0 || m == nil {
			t.Fatalf("generated passphrase: %+v", r)
		}
		if got := c.runEnv([]string{"CRYPTEX_PASSPHRASE=" + m[1]}, "", "open", l); got.out != "generated" {
			t.Fatalf("open with generated passphrase: %+v", got)
		}
	})

	t.Run("multi-view", func(t *testing.T) {
		c.t = t
		l, id := link(t, c.ok("DB_HOST=db\nDB_PASSWORD=\"x y\"\n", "send", "--views", "3", "--fields"))
		env := c.ok("", "open", l, "--as", "env")
		if env != "DB_HOST=db\nDB_PASSWORD=\"x y\"\n" {
			t.Fatalf("env: %q", env)
		}
		o := jsonOut(t, c.ok("", "open", l, "--json"))
		if o["views_left"] != 1.0 {
			t.Fatalf("views_left %v", o["views_left"])
		}
		f := o["items"].([]any)[1].(map[string]any)
		if f["t"] != "field" || f["k"] != "DB_PASSWORD" || f["v"] != "x y" || f["secret"] != true {
			t.Fatalf("field %v", f)
		}
		st := jsonOut(t, c.ok("", "status", id, "--json"))
		if st["status"] != "opened" || st["views_left"] != 1.0 {
			t.Fatalf("status %v", st)
		}
		if txt := c.ok("", "open", l); txt != "DB_HOST: db\nDB_PASSWORD: x y\n" {
			t.Fatalf("text: %q", txt)
		}
		c.code(4, "", "open", l)
	})

	t.Run("request, answer, open", func(t *testing.T) {
		c.t = t
		ql, id := link(t, c.ok("", "request", "AWS read-only keys", "--field", "Access key ID", "--field", "Secret access key",
			"--message", "Read-only is enough", "--keep", "1d", "--files"))
		keyFile := filepath.Join(cfgDir, "keys", id+".pem")
		if fi, err := os.Stat(keyFile); err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("key file: %v %v", fi, err)
		}
		// Not answered yet.
		c.code(3, "", "open", id)
		// Someone else (another config dir) sees the prompt.
		other := &cli{t: t, bin: bin, env: []string{"CRYPTEX_CONFIG_DIR=" + t.TempDir(), "CRYPTEX_KEYRING=file", "CRYPTEX_NO_PROMPT=1",
			"CRYPTEX_TOKEN=", "CRYPTEX_SERVER="}}
		p := jsonOut(t, other.ok("", "open", ql, "--json"))
		if p["title"] != "AWS read-only keys" || p["message"] != "Read-only is enough" || len(p["fields"].([]any)) != 2 {
			t.Fatalf("prompt %v", p)
		}
		other.code(7, "", "answer", ql[:len(ql)-3])
		dir := t.TempDir()
		_ = os.WriteFile(filepath.Join(dir, "policy.json"), []byte(`{"read":true}`), 0o600)
		ans := "Access key ID: AKIAIOSFODNN7EXAMPLE\r\nSecret access key: wJalrXUtnFEMI/K7MDENG\r\n"
		other.ok(ans, "answer", ql, filepath.Join(dir, "policy.json"))
		other.code(4, "", "answer", ql)

		st := jsonOut(t, c.ok("", "status", id, "--json"))
		if st["status"] != "answered" {
			t.Fatalf("status %v", st)
		}
		out := filepath.Join(dir, "got")
		env := c.ok("", "open", ql, "--as", "env", "--out", out)
		if env != "ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nSECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG\n# file: "+filepath.Join(out, "policy.json")+"\n" {
			t.Fatalf("env: %q", env)
		}
		if b, _ := os.ReadFile(filepath.Join(out, "policy.json")); string(b) != `{"read":true}` {
			t.Fatalf("policy.json: %q", b)
		}
		o := jsonOut(t, c.ok("", "open", id, "--json", "--out", out))
		if o["kind"] != "answer" || len(o["items"].([]any)) != 3 {
			t.Fatalf("answer json %v", o)
		}
		st = jsonOut(t, c.ok("", "status", id, "--json"))
		if st["status"] != "revealed" {
			t.Fatalf("status %v", st)
		}
		c.ok("", "destroy", id)
		if _, err := os.Stat(keyFile); !os.IsNotExist(err) {
			t.Fatal("request key not deleted after destroy")
		}
	})

	t.Run("single-field request takes the whole text", func(t *testing.T) {
		c.t = t
		ql, id := link(t, c.ok("", "request", "API token", "--field", "Token"))
		c.ok("tok_123 456\n", "answer", ql)
		o := jsonOut(t, c.ok("", "open", id, "--json"))
		f := o["items"].([]any)[0].(map[string]any)
		if f["k"] != "Token" || f["v"] != "tok_123 456" {
			t.Fatalf("field %v", f)
		}
	})

	t.Run("cancel an answered, unread request", func(t *testing.T) {
		c.t = t
		ql, id := link(t, c.ok("", "request", "Never read", "--field", "Token"))
		c.ok("tok", "answer", ql)
		c.ok("", "destroy", id)
		st := jsonOut(t, c.ok("", "status", id, "--json"))
		if st["status"] != "destroyed" {
			t.Fatalf("status %v", st)
		}
		evs, _ := st["events"].([]any)
		last, _ := evs[len(evs)-1].(map[string]any)
		if last["type"] != "request.cancelled" {
			t.Fatalf("events %v", evs)
		}
		if _, err := os.Stat(filepath.Join(cfgDir, "keys", id+".pem")); !os.IsNotExist(err) {
			t.Fatal("request key kept after cancel")
		}
		c.code(1, "", "open", id) // no key left to read with
		other := &cli{t: t, bin: bin, env: []string{"CRYPTEX_CONFIG_DIR=" + t.TempDir(), "CRYPTEX_KEYRING=file", "CRYPTEX_NO_PROMPT=1",
			"CRYPTEX_TOKEN=", "CRYPTEX_SERVER="}}
		other.code(4, "", "answer", ql) // the responder's link is gone
	})

	t.Run("status watch", func(t *testing.T) {
		c.t = t
		l, id := link(t, c.ok("watch me", "send"))
		cmd := exec.Command(bin, "status", "--watch", id, "--json")
		cmd.Env = append(os.Environ(), c.env...)
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		time.Sleep(1500 * time.Millisecond)
		c.ok("", "open", l)
		select {
		case err := <-done:
			if err != nil || !strings.Contains(out.String(), `"status":"opened"`) {
				t.Fatalf("watch: %v\n%s", err, out.String())
			}
		case <-time.After(20 * time.Second):
			_ = cmd.Process.Kill()
			t.Fatalf("watch didn't finish:\n%s", out.String())
		}
	})

	t.Run("destroy", func(t *testing.T) {
		c.t = t
		l, id := link(t, c.ok("short-lived", "send"))
		c.ok("", "destroy", id)
		c.ok("", "destroy", id) // idempotent
		r := c.code(4, "", "open", l, "--json")
		if e := jsonOut(t, r.out)["error"].(map[string]any); e["reason"] != "destroyed" {
			t.Fatalf("error %v", e)
		}
		if st := jsonOut(t, c.ok("", "status", id, "--json")); st["status"] != "destroyed" {
			t.Fatalf("status %v", st)
		}
		ls := c.ok("", "ls")
		if !strings.Contains(ls, id) || !strings.Contains(ls, "destroyed") {
			t.Fatalf("ls: %s", ls)
		}
	})

	t.Run("exit codes", func(t *testing.T) {
		c.t = t
		// 3: unknown ID or wrong key (identical 404).
		c.code(3, "", "open", srv.url+"/s/AAAAAAAAAA#08hLdXPyTgClYg1aikN6PA")
		l, id := link(t, c.ok("x", "send"))
		wrong := l[:len(l)-22] + "08hLdXPyTgClYg1aikN6PA"
		c.code(3, "", "open", wrong)
		c.code(3, "", "destroy", "ZZZZZZZZZZ")
		c.code(3, "", "open", srv.url+"/q/AAAAAAAAAA#qnqxus2D-rhK_h7LhR1bQOCMK5Ahqoo9")
		// 7: incomplete links, without any network call (port 1 would fail with exit 2).
		c.code(7, "", "open", "http://127.0.0.1:1/s/"+id+"#08hLdXPyTgClYg")
		c.code(7, "", "open", "http://127.0.0.1:1/s/"+id)
		c.code(7, "", "open", "http://127.0.0.1:1/s/"+id+"#")
		c.code(7, "", "open", "http://127.0.0.1:1/q/"+id+"#qnqxus2D-rhK_h7LhR1b")
		r := c.code(7, "", "open", "http://127.0.0.1:1/s/"+id+"#08hLdXPyTgClYg", "--json")
		if jsonOut(t, r.out)["error"].(map[string]any)["code"] != "incomplete_link" {
			t.Fatalf("json: %s", r.out)
		}
		// 2: network error. 1: usage.
		c.code(2, "", "open", "http://127.0.0.1:1/s/"+id+"#08hLdXPyTgClYg1aikN6PA")
		c.code(1, "", "send", "--views", "0", "--once", "--views", "2")
		c.code(1, "", "open")
		c.code(1, "x", "send", "--ttl", "99d")
		c.code(1, "", "nonsense")
	})

	t.Run("logout", func(t *testing.T) {
		c.t = t
		c.ok("", "logout")
		// Anonymous sends still work on an "anyone" server.
		l, _ := link(t, c.ok("anon", "send"))
		if got := c.ok("", "open", l); got != "anon" {
			t.Fatalf("open: %q", got)
		}
	})

	t.Run("demo proof of work", func(t *testing.T) {
		c.t = t
		demo := startServer(t, apiDir, "DEMO=true")
		d := &cli{t: t, bin: bin, env: []string{"CRYPTEX_CONFIG_DIR=" + t.TempDir(), "CRYPTEX_KEYRING=file", "CRYPTEX_NO_PROMPT=1",
			"CRYPTEX_TOKEN=", "CRYPTEX_SERVER=" + demo.url}}
		l, _ := link(t, d.ok("demo secret", "send"))
		if got := d.ok("", "open", l); got != "demo secret" {
			t.Fatalf("open: %q", got)
		}
		ql, id := link(t, d.ok("", "request", "demo request", "--field", "Password"))
		d.ok("hunter2", "answer", ql)
		if got := d.ok("", "open", id); got != "Password: hunter2\n" {
			t.Fatalf("answer: %q", got)
		}
	})
}

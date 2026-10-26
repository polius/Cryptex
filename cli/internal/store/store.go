// Package store keeps the CLI's local state: config.toml, the API token, receipts and request keys.
//
// Layout (all files 0600, directories 0700):
//
//	<dir>/config.toml       server = "https://vault.acme.com"
//	<dir>/receipts.json     receipts created by this CLI (manage tokens)
//	<dir>/keys/<id>.pem     request private keys (PKCS#8)
//	<dir>/credentials.json  API tokens, only when no OS keychain is available
//
// <dir> is $CRYPTEX_CONFIG_DIR, else %APPDATA%\cryptex on Windows, else $XDG_CONFIG_HOME/cryptex,
// else ~/.config/cryptex.
package store

import (
	"bufio"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

// Dir returns the configuration directory.
func Dir() (string, error) {
	if d := os.Getenv("CRYPTEX_CONFIG_DIR"); d != "" {
		return d, nil
	}
	if runtime.GOOS == "windows" {
		if d := os.Getenv("APPDATA"); d != "" {
			return filepath.Join(d, "cryptex"), nil
		}
	}
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "cryptex"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("can't find the home directory: %w", err)
	}
	return filepath.Join(home, ".config", "cryptex"), nil
}

// Store is the local state directory.
type Store struct{ Dir string }

// Open resolves the directory (it's created lazily on first write).
func Open() (*Store, error) {
	d, err := Dir()
	if err != nil {
		return nil, err
	}
	return &Store{Dir: d}, nil
}

func (s *Store) path(name ...string) string {
	return filepath.Join(append([]string{s.Dir}, name...)...)
}

func (s *Store) ensure(sub string) error {
	if err := os.MkdirAll(s.path(sub), 0o700); err != nil {
		return err
	}
	return nil
}

// writeFile writes atomically with 0600 permissions.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---------------------------------------------------------------- config.toml

var tomlLine = regexp.MustCompile(`^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$`)

// Config reads config.toml (a flat subset of TOML: key = "string" lines and # comments).
func (s *Store) Config() (map[string]string, error) {
	out := map[string]string{}
	f, err := os.Open(s.path("config.toml"))
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
			continue
		}
		m := tomlLine.FindStringSubmatch(line)
		if m == nil {
			return nil, fmt.Errorf("config.toml line %d: expected key = \"value\"", n)
		}
		v := m[2]
		if i := strings.Index(v, " #"); i >= 0 && !strings.HasPrefix(v, `"`) {
			v = strings.TrimSpace(v[:i])
		}
		if strings.HasPrefix(v, `"`) {
			end := strings.LastIndex(v, `"`)
			if end <= 0 {
				return nil, fmt.Errorf("config.toml line %d: unterminated string", n)
			}
			uq, err := strconv.Unquote(v[:end+1])
			if err != nil {
				return nil, fmt.Errorf("config.toml line %d: %w", n, err)
			}
			v = uq
		} else if strings.HasPrefix(v, `'`) && strings.Count(v, `'`) >= 2 {
			v = v[1:strings.LastIndex(v, `'`)]
		}
		out[m[1]] = v
	}
	return out, sc.Err()
}

// SetConfig sets one key in config.toml, keeping every other line as it was.
func (s *Store) SetConfig(key, value string) error {
	var lines []string
	if b, err := os.ReadFile(s.path("config.toml")); err == nil {
		lines = strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	}
	newLine := key + " = " + strconv.Quote(value)
	done := false
	for i, l := range lines {
		if m := tomlLine.FindStringSubmatch(l); m != nil && m[1] == key && !strings.HasPrefix(strings.TrimSpace(l), "#") {
			lines[i], done = newLine, true
		}
	}
	if !done {
		lines = append(lines, newLine)
	}
	return writeFile(s.path("config.toml"), []byte(strings.Join(lines, "\n")+"\n"))
}

// ---------------------------------------------------------------- API token

const keyringService = "cryptex"

func useKeyring() bool {
	v := strings.ToLower(os.Getenv("CRYPTEX_KEYRING"))
	return v != "file" && v != "off" && v != "0" && v != "false"
}

func (s *Store) creds() (map[string]string, error) {
	out := map[string]string{}
	b, err := os.ReadFile(s.path("credentials.json"))
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	return out, json.Unmarshal(b, &out)
}

// Token returns the stored API token for a server, or "".
func (s *Store) Token(server string) (string, error) {
	if useKeyring() {
		if t, err := keyring.Get(keyringService, server); err == nil && t != "" {
			return t, nil
		}
	}
	c, err := s.creds()
	if err != nil {
		return "", err
	}
	return c[server], nil
}

// SetToken stores the token in the OS keychain, or in credentials.json (0600) when there is none.
// It returns where it was stored.
func (s *Store) SetToken(server, token string) (string, error) {
	if useKeyring() {
		if err := keyring.Set(keyringService, server, token); err == nil {
			_ = s.deleteFileToken(server)
			return "the system keychain", nil
		}
	}
	c, err := s.creds()
	if err != nil {
		return "", err
	}
	c[server] = token
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := writeFile(s.path("credentials.json"), b); err != nil {
		return "", err
	}
	return s.path("credentials.json"), nil
}

func (s *Store) deleteFileToken(server string) error {
	c, err := s.creds()
	if err != nil || c[server] == "" {
		return err
	}
	delete(c, server)
	b, _ := json.MarshalIndent(c, "", "  ")
	return writeFile(s.path("credentials.json"), b)
}

// DeleteToken removes the token from the keychain and the file. It reports whether one existed.
func (s *Store) DeleteToken(server string) (bool, error) {
	found := false
	if useKeyring() {
		if err := keyring.Delete(keyringService, server); err == nil {
			found = true
		}
	}
	c, err := s.creds()
	if err != nil {
		return found, err
	}
	if c[server] != "" {
		found = true
	}
	return found, s.deleteFileToken(server)
}

// ---------------------------------------------------------------- receipts

// Receipt is what the CLI remembers about an item it created.
type Receipt struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"` // secret | request
	Server      string    `json:"server"`
	ManageToken string    `json:"manage_token"`
	Link        string    `json:"link,omitempty"` // with its key; removed once the status is final
	Title       string    `json:"title,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   string    `json:"expires_at,omitempty"`
	MaxViews    int       `json:"max_views,omitempty"`
	ViewsLeft   *int      `json:"views_left,omitempty"`
	Status      string    `json:"status"`
	CheckedAt   time.Time `json:"checked_at,omitzero"`
}

type receiptFile struct {
	Version int        `json:"version"`
	Items   []*Receipt `json:"items"`
}

// Receipts loads receipts.json, newest first.
func (s *Store) Receipts() ([]*Receipt, error) {
	b, err := os.ReadFile(s.path("receipts.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f receiptFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("receipts.json: %w", err)
	}
	sort.SliceStable(f.Items, func(i, j int) bool { return f.Items[i].CreatedAt.After(f.Items[j].CreatedAt) })
	return f.Items, nil
}

// SaveReceipts writes receipts.json.
func (s *Store) SaveReceipts(items []*Receipt) error {
	b, err := json.MarshalIndent(receiptFile{Version: 1, Items: items}, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(s.path("receipts.json"), append(b, '\n'))
}

// Receipt finds one receipt by ID.
func (s *Store) Receipt(id string) (*Receipt, error) {
	items, err := s.Receipts()
	if err != nil {
		return nil, err
	}
	for _, r := range items {
		if r.ID == id {
			return r, nil
		}
	}
	return nil, nil
}

// PutReceipt inserts or replaces a receipt by ID.
func (s *Store) PutReceipt(r *Receipt) error {
	items, err := s.Receipts()
	if err != nil {
		return err
	}
	for i, x := range items {
		if x.ID == r.ID {
			items[i] = r
			return s.SaveReceipts(items)
		}
	}
	return s.SaveReceipts(append([]*Receipt{r}, items...))
}

// ---------------------------------------------------------------- request keys

func (s *Store) keyPath(id string) string { return s.path("keys", id+".pem") }

// SaveKey stores a request private key (PKCS#8 DER) as keys/<id>.pem with 0600 permissions.
func (s *Store) SaveKey(id string, pkcs8 []byte) error {
	if err := s.ensure("keys"); err != nil {
		return err
	}
	return writeFile(s.keyPath(id), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
}

// Key loads a request private key, or nil if there is none.
func (s *Store) Key(id string) ([]byte, error) {
	b, err := os.ReadFile(s.keyPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(b)
	if blk == nil || blk.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s isn't a PKCS#8 PEM key", s.keyPath(id))
	}
	return blk.Bytes, nil
}

// DeleteKey removes a request private key if present.
func (s *Store) DeleteKey(id string) error {
	err := os.Remove(s.keyPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// KeyPath is where a request's key lives (for messages).
func (s *Store) KeyPath(id string) string { return s.keyPath(id) }

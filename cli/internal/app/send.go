package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
	"unicode/utf8"

	"github.com/polius/cryptex/cli/internal/api"
	"github.com/polius/cryptex/cli/internal/crypto"
	"github.com/polius/cryptex/cli/internal/store"
)

// readText reads stdin as text, refusing binary data or more than maxBytes.
func (a *App) readText(maxBytes int64, prompt string) (string, error) {
	if a.stdinIsTTY() {
		if noPrompt() {
			return "", nil
		}
		fmt.Fprintln(a.Stderr, prompt)
	}
	b, err := io.ReadAll(io.LimitReader(a.Stdin, maxBytes+1))
	if err != nil {
		return "", usagef("reading stdin: %v", err)
	}
	if int64(len(b)) > maxBytes {
		return "", usagef("stdin is longer than this server's message limit; send it as a file instead")
	}
	if !utf8.Valid(b) {
		return "", usagef("stdin isn't UTF-8 text; send binary data as a file argument instead")
	}
	return string(b), nil
}

func (a *App) newPassphrase() (string, error) {
	if p := os.Getenv("CRYPTEX_PASSPHRASE"); p != "" {
		return p, nil
	}
	p1, err := a.promptSecret("Passphrase: ")
	if err != nil {
		return "", usagef("--passphrase needs a terminal to prompt on, or set CRYPTEX_PASSPHRASE")
	}
	if p1 == "" {
		return "", usagef("empty passphrase")
	}
	p2, err := a.promptSecret("Repeat passphrase: ")
	if err != nil {
		return "", err
	}
	if p1 != p2 {
		return "", usagef("the passphrases don't match")
	}
	return p1, nil
}

// withPoW adds the demo proof-of-work header when the server asks for it.
func (a *App) withPoW(c *api.Client, cfg *ServerConfig, h map[string]string) (map[string]string, error) {
	if h == nil {
		h = map[string]string{}
	}
	if cfg != nil && cfg.Demo {
		pow, err := c.PoW(a.ctx)
		if err != nil {
			return nil, err
		}
		h["X-PoW"] = pow
	}
	return h, nil
}

func (a *App) cmdSend(args []string) error {
	fs := a.flags("send", "[file…]", "Encrypt stdin and/or files locally, upload them, and print the link.\nThe link carries the key: anyone with the whole link can open it.")
	title := fs.String("title", "", "title shown to the recipient before they open it")
	once := fs.Bool("once", false, "one view (the default)")
	views := fs.Int("views", 0, "number of views allowed")
	ttl := fs.String("ttl", "", "expires after this long: 1h, 1d, 7d… (default: the server's default)")
	email := fs.String("email", "", "only this email address can open it (needs a code we email them)")
	org := fs.Bool("org", false, "only people signed in to your organization can open it")
	withPass := fs.Bool("passphrase", false, "also require a passphrase (prompted, or CRYPTEX_PASSPHRASE)")
	genPass := fs.Bool("generate-passphrase", false, "generate a passphrase and print it once to stderr")
	notify := fs.Bool("notify", false, "email me when it's opened")
	fields := fs.Bool("fields", false, "parse stdin into fields (KEY=value, key: value, URLs, PEM keys…)")
	copyLink := fs.Bool("copy", false, "also copy the link to the clipboard")
	files, err := fs.parse(args)
	if err != nil {
		return err
	}
	if *once && *views > 1 {
		return usagef("--once and --views %d contradict each other", *views)
	}
	if *withPass && *genPass {
		return usagef("use --passphrase or --generate-passphrase, not both")
	}
	if *email != "" && *org {
		return usagef("use --email or --org, not both")
	}
	server, err := a.serverURL()
	if err != nil {
		return err
	}
	c := a.client(server)
	cfg, err := a.serverConfig(c)
	if err != nil {
		return err
	}

	// Policy, checked against the server's limits before anything is encrypted.
	n := 1
	if *views > 0 {
		n = *views
	}
	if n > cfg.Limits.MaxViews {
		return usagef("--views %d is over this server's limit of %d", n, cfg.Limits.MaxViews)
	}
	expires := cfg.Defaults.ExpiresIn
	if *ttl != "" {
		if expires, err = ParseDuration(*ttl); err != nil {
			return usagef("--ttl: %v", err)
		}
	}
	if expires < 300 {
		return usagef("--ttl must be at least 5m")
	}
	if cfg.Limits.MaxExpiresIn > 0 && expires > cfg.Limits.MaxExpiresIn {
		return usagef("--ttl %s is over this server's limit of %s", humanDuration(expires), humanDuration(cfg.Limits.MaxExpiresIn))
	}
	access := "link"
	switch {
	case *email != "":
		access = "email"
	case *org:
		access = "org"
	}

	// Content.
	var text []Item
	if !a.stdinIsTTY() || len(files) == 0 {
		maxBytes := int64(cfg.Limits.MaxMessageChars)*4 + 1
		s, err := a.readText(maxBytes, "Type or paste the secret, then press Ctrl-D (Ctrl-Z Enter on Windows):")
		if err != nil {
			return err
		}
		if s != "" {
			var parsed bool
			text, parsed = textItems(s, *fields)
			if *fields && !parsed {
				a.warn("no fields found in stdin; sending it as a note")
			}
		}
	}
	ct, err := buildContent(text, files, cfg.Limits.MaxFiles, cfg.Limits.MaxFileBytes, cfg.Limits.MaxMessageChars)
	if err != nil {
		return err
	}

	meta, err := json.Marshal(struct {
		Title *string `json:"title"`
		From  *string `json:"from"`
	}{strPtr(*title), a.senderName(cfg)})
	if err != nil {
		return err
	}
	if len(meta) > 1024 {
		return usagef("the title is too long")
	}

	passphrase := ""
	switch {
	case *withPass:
		if passphrase, err = a.newPassphrase(); err != nil {
			return err
		}
	case *genPass:
		passphrase = crypto.GeneratePassphrase()
	}

	policy := map[string]any{"views": n, "expires_in": expires, "access": access, "passphrase": passphrase != "", "notify": *notify}
	if access == "email" {
		policy["email"] = *email
	}
	var salt []byte
	if passphrase != "" {
		salt = crypto.Random(16)
		policy["passphrase_salt"] = crypto.B64u(salt)
	}

	// Phase 1: create (the server assigns the ID that every key is bound to).
	hdr, err := a.withPoW(c, cfg, nil)
	if err != nil {
		return err
	}
	var created struct {
		ID          string `json:"id"`
		UploadToken string `json:"upload_token"`
		ManageToken string `json:"manage_token"`
		ExpiresAt   string `json:"expires_at"`
	}
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: "/secrets", Auth: api.AuthBearer, Header: hdr,
		JSON: map[string]any{"policy": policy, "streams": ct.descs()}}, &created); err != nil {
		return err
	}
	if !idRe.MatchString(created.ID) {
		return failf("the server returned an invalid ID %q", created.ID)
	}
	upAuth := "Upload " + created.UploadToken
	sealed := false
	defer func() {
		if !sealed { // never leave a half-uploaded secret behind
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_, _, _ = c.Do(ctx, api.Call{Method: http.MethodDelete, Path: "/secrets/" + created.ID + "/upload", Auth: upAuth})
		}
	}()

	// Phase 2: derive the keys, encrypt, upload, seal.
	K := crypto.Random(16)
	keys := crypto.DeriveLink(created.ID, K)
	contentKey := keys.ContentKey
	seal := map[string]any{"reveal_hash": keys.RevealHash()}
	if passphrase != "" {
		pk := crypto.DerivePassphrase(created.ID, K, passphrase, salt)
		contentKey = pk.ContentKey
		seal["passcheck_hash"] = pk.PasscheckHash()
	}
	up := &uploader{a: a, client: c, path: "/secrets/" + created.ID + "/chunks", auth: upAuth, key: contentKey, id: created.ID}
	if err := up.upload(ct.sources); err != nil {
		return err
	}
	seal["meta_ct"] = crypto.SealBlob(keys.MetaKey, "meta", created.ID, meta, nil)
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: "/secrets/" + created.ID + "/seal", Auth: upAuth,
		JSON: seal, Idempotent: true}, nil); err != nil && !isCode(err, "already_sealed") {
		return err
	}
	sealed = true

	link := linkBase(server, cfg) + "/s/" + created.ID + "#" + crypto.B64u(K)
	if st, err := a.st(); err == nil {
		r := &store.Receipt{ID: created.ID, Kind: "secret", Server: server, ManageToken: created.ManageToken, Link: link,
			Title: *title, CreatedAt: time.Now().UTC(), ExpiresAt: created.ExpiresAt, MaxViews: n, ViewsLeft: &n, Status: "waiting"}
		if err := st.PutReceipt(r); err != nil {
			a.warn("couldn't save the receipt (status and destroy won't know this item): %v", err)
		}
	}
	if *genPass {
		fmt.Fprintln(a.Stderr, "Passphrase (shown once, send it separately): "+passphrase)
	}
	if *copyLink {
		if err := copyToClipboard(link); err != nil {
			a.warn("%v", err)
		} else {
			a.info("Link copied to the clipboard.")
		}
	}
	if a.json {
		a.printJSON(map[string]any{"link": link, "id": created.ID, "expires_at": created.ExpiresAt, "views": n,
			"access": access, "passphrase": passphrase != "", "files": ct.files()})
		return nil
	}
	fmt.Fprintln(a.Stdout, link)
	return nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func isCode(err error, code string) bool {
	var ae *api.Error
	return errors.As(err, &ae) && ae.Code == code
}

package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/polius/cryptex/cli/internal/api"
	"github.com/polius/cryptex/cli/internal/crypto"
	"github.com/polius/cryptex/cli/internal/paste"
)

// OutItem is a decrypted item as printed by open.
type OutItem struct {
	T      string `json:"t"`
	K      string `json:"k,omitempty"`
	V      string `json:"v,omitempty"`
	Secret bool   `json:"secret,omitempty"`
	Name   string `json:"name,omitempty"`
	Type   string `json:"type,omitempty"`
	Size   int64  `json:"size,omitempty"`
	Path   string `json:"path,omitempty"`
}

// Opened is the result of open.
type Opened struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"` // secret | answer
	Title     *string   `json:"title"`
	From      *string   `json:"from"`
	ViewsLeft *int      `json:"views_left,omitempty"`
	Items     []OutItem `json:"items"`
}

func (a *App) anon(base string) *api.Client {
	c := api.New(base, "", "cryptex-cli/"+Version)
	if a.verbose {
		c.Verbose = func(f string, x ...any) { fmt.Fprintf(a.Stderr, "cryptex: "+f+"\n", x...) }
	}
	return c
}

func (a *App) cmdOpen(args []string) error {
	fs := a.flags("open", "LINK|ID", "Reveal a secret (this uses one of its views), or read the answer to a request you made.\nFor someone else's request link, it shows what they ask for; answer with `cryptex answer`.")
	as := fs.String("as", "text", "output format: text, env or json")
	out := fs.String("out", ".", "directory for files")
	pass := fs.String("passphrase", "", "the secret's passphrase (or CRYPTEX_PASSPHRASE, or you'll be prompted)")
	wait := fs.Bool("wait", false, "for a request: wait until it's answered")
	pos, err := fs.parse(args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usagef("usage: cryptex open LINK|ID")
	}
	if a.json {
		*as = "json"
	}
	if *as != "text" && *as != "env" && *as != "json" {
		return usagef("--as must be text, env or json")
	}
	if *pass == "" {
		*pass = os.Getenv("CRYPTEX_PASSPHRASE")
	}
	o := openOpts{as: *as, out: *out, pass: *pass, wait: *wait}

	arg := pos[0]
	if !strings.Contains(arg, "://") {
		if !idRe.MatchString(arg) {
			return usagef("not a link or ID: %q", arg)
		}
		st, err := a.st()
		if err != nil {
			return err
		}
		r, err := st.Receipt(arg)
		if err != nil {
			return err
		}
		switch {
		case r == nil:
			return usagef("%s isn't in this CLI's receipts; open it with the full link", arg)
		case r.Kind == "request":
			return a.openAnswer(r.Server, arg, o)
		case r.Link == "":
			return usagef("the link for %s is no longer stored (status %s); open it with the full link", arg, r.Status)
		}
		arg = r.Link
	}
	l, err := ParseLink(arg)
	if err != nil {
		return err
	}
	if l.Kind == "s" {
		return a.openSecret(l, o)
	}
	// A request: the requester holds its private key; anyone else sees the prompt.
	if st, err := a.st(); err == nil {
		if k, _ := st.Key(l.ID); k != nil {
			server := l.Base
			if r, _ := st.Receipt(l.ID); r != nil && r.Server != "" {
				server = r.Server
			}
			return a.openAnswer(server, l.ID, o)
		}
	}
	return a.showPrompt(l)
}

type openOpts struct {
	as, out, pass string
	wait          bool
}

// SecretMeta is GET /secrets/{id}/meta.
type SecretMeta struct {
	MetaCt         string `json:"meta_ct"`
	ViewsLeft      int    `json:"views_left"`
	MaxViews       int    `json:"max_views"`
	ExpiresAt      string `json:"expires_at"`
	Access         string `json:"access"`
	Passphrase     bool   `json:"passphrase"`
	PassphraseSalt string `json:"passphrase_salt"`
	TriesLeft      *int   `json:"tries_left"`
	Files          int    `json:"files"`
	Size           int64  `json:"size"`
	EmailHint      string `json:"email_hint"`
	OrgName        string `json:"org_name"`
}

type metaPlain struct {
	Title *string `json:"title"`
	From  *string `json:"from"`
}

func (a *App) openSecret(l *Link, o openOpts) error {
	if !l.HasFragment {
		return errIncomplete
	}
	K, err := crypto.ParseSecretFragment(l.Fragment)
	if err != nil {
		return errIncomplete
	}
	keys := crypto.DeriveLink(l.ID, K)
	c := a.anon(l.Base)
	reveal := "Reveal " + crypto.B64u(keys.RevealToken)
	base := "/secrets/" + l.ID

	var meta SecretMeta
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodGet, Path: base + "/meta", Auth: reveal, Idempotent: true}, &meta); err != nil {
		return err
	}
	var mp metaPlain
	pt, err := crypto.OpenBlob(keys.MetaKey, "meta", l.ID, meta.MetaCt)
	if err != nil || json.Unmarshal(pt, &mp) != nil {
		return failf("the secret's title doesn't decrypt: the link or the server data was changed")
	}
	a.describeSecret(mp, meta)

	if meta.Access == "org" {
		org := meta.OrgName
		if org == "" {
			org = "your organization"
		}
		return failf("this link only opens for people signed in at %s. Open it in a browser and sign in", org)
	}
	hdr := map[string]string{}
	if meta.Access == "email" {
		g, err := a.emailGrant(c, base, reveal, meta.EmailHint)
		if err != nil {
			return err
		}
		hdr["X-Access-Grant"] = g
	}
	if meta.Files > 0 {
		if err := ensureOutDir(o.out); err != nil {
			return err
		}
	}

	contentKey := keys.ContentKey
	var revealed struct {
		ReadSession string       `json:"read_session"`
		Streams     []StreamDesc `json:"streams"`
		ViewsLeft   int          `json:"views_left"`
	}
	interactive := o.pass == ""
	for {
		if meta.Passphrase {
			salt, err := crypto.UnB64u(meta.PassphraseSalt)
			if err != nil || len(salt) != 16 {
				return failf("the server sent a malformed passphrase salt")
			}
			p := o.pass
			if p == "" {
				p, err = a.promptSecret("Passphrase: ")
				if err != nil {
					return usagef("this secret needs a passphrase: pass --passphrase or set CRYPTEX_PASSPHRASE")
				}
			}
			pk := crypto.DerivePassphrase(l.ID, K, p, salt)
			contentKey = pk.ContentKey
			hdr["X-Passcheck"] = crypto.B64u(pk.Passcheck)
		}
		err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: base + "/reveal", Auth: reveal, Header: hdr}, &revealed)
		var ae *api.Error
		if errors.As(err, &ae) && ae.Code == "wrong_passphrase" && interactive && ae.TriesLeft != nil && *ae.TriesLeft > 0 {
			if canPrompt() {
				fmt.Fprintf(a.Stderr, "Wrong passphrase. %d tries left before the secret is destroyed.\n", *ae.TriesLeft)
				continue
			}
		}
		if err != nil {
			return err
		}
		break
	}

	d := &downloader{a: a, client: c, path: base + "/chunks", auth: "Read " + revealed.ReadSession, key: contentKey, id: l.ID}
	items, err := d.payload(revealed.Streams, o.out)
	if err != nil {
		return err
	}
	// Everything decrypted: end the read session. On the last view this deletes the data now instead of
	// after the server's retry grace. Errors don't matter here; the session expires on its own.
	_, _, _ = c.Do(a.ctx, api.Call{Method: http.MethodDelete, Path: base + "/read", Auth: d.auth, Idempotent: true})
	vl := revealed.ViewsLeft
	return a.printOpened(Opened{ID: l.ID, Kind: "secret", Title: mp.Title, From: mp.From, ViewsLeft: &vl, Items: items}, o.as)
}

func (a *App) describeSecret(mp metaPlain, meta SecretMeta) {
	if a.json {
		return
	}
	var b strings.Builder
	b.WriteString("Opening")
	if mp.Title != nil && *mp.Title != "" {
		fmt.Fprintf(&b, " “%s”", *mp.Title)
	}
	if mp.From != nil && *mp.From != "" {
		fmt.Fprintf(&b, " from %s", *mp.From)
	}
	var notes []string
	if meta.Files > 0 {
		notes = append(notes, plural(meta.Files, "file"))
	}
	if meta.ViewsLeft == 1 {
		notes = append(notes, "last view")
	} else {
		notes = append(notes, plural(meta.ViewsLeft, "view")+" left")
	}
	fmt.Fprintf(&b, " (%s)", strings.Join(notes, ", "))
	fmt.Fprintln(a.Stderr, b.String())
}

// emailGrant runs the email-code check for email-only links.
func (a *App) emailGrant(c *api.Client, base, reveal, hint string) (string, error) {
	if !canPrompt() {
		return "", failf("this link only opens for %s, with a code sent by email. Run cryptex open in a terminal", hint)
	}
	err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: base + "/verify/start", Auth: reveal}, nil)
	var ae *api.Error
	if err != nil && !(errors.As(err, &ae) && ae.Status == http.StatusTooManyRequests) {
		return "", err
	}
	fmt.Fprintf(a.Stderr, "This link only opens for %s. We emailed a 6-digit code to that address.\n", hint)
	for {
		code, err := a.promptLine("Code: ")
		if err != nil {
			return "", err
		}
		var out struct {
			Grant string `json:"grant"`
		}
		err = c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: base + "/verify", Auth: reveal,
			JSON: map[string]string{"code": strings.TrimSpace(code)}}, &out)
		if errors.As(err, &ae) && (ae.Code == "wrong_code" || ae.Code == "invalid") {
			msg := "That code didn't work."
			if ae.TriesLeft != nil {
				msg += fmt.Sprintf(" %d tries left.", *ae.TriesLeft)
			}
			fmt.Fprintln(a.Stderr, msg)
			continue
		}
		if err != nil {
			return "", err
		}
		return out.Grant, nil
	}
}

// ---------------------------------------------------------------- requests

// Prompt is a decrypted request prompt.
type Prompt struct {
	Title   *string  `json:"title"`
	From    *string  `json:"from"`
	Message *string  `json:"message"`
	Fields  []string `json:"fields"`
	Files   bool     `json:"files"`
}

type promptResp struct {
	PublicKey string `json:"public_key"`
	PromptCt  string `json:"prompt_ct"`
	Files     bool   `json:"files"`
	ExpiresAt string `json:"expires_at"`
	Limits    struct {
		MaxFiles        int   `json:"max_files"`
		MaxFileBytes    int64 `json:"max_file_bytes"`
		MaxMessageChars int   `json:"max_message_chars"`
	} `json:"limits"`
}

// fetchPrompt gets the prompt, checks the requester's key fingerprint and decrypts it.
func (a *App) fetchPrompt(c *api.Client, l *Link) (*promptResp, *Prompt, string, []byte, error) {
	if !l.HasFragment {
		return nil, nil, "", nil, errIncomplete
	}
	P, fp, err := crypto.ParseRequestFragment(l.Fragment)
	if err != nil {
		return nil, nil, "", nil, errIncomplete
	}
	promptKey, answerToken := crypto.PromptKeys(l.ID, P)
	auth := "Answer " + crypto.B64u(answerToken)
	var pr promptResp
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodGet, Path: "/requests/" + l.ID + "/prompt", Auth: auth, Idempotent: true}, &pr); err != nil {
		return nil, nil, "", nil, err
	}
	spki, err := crypto.UnB64u(pr.PublicKey)
	if err != nil || !bytesEqual(crypto.Fingerprint(spki), fp) {
		return nil, nil, "", nil, failf("the requester's key doesn't match the link's fingerprint: the server may have swapped it. Nothing was sent")
	}
	if _, err := crypto.ParseSPKI(spki); err != nil {
		return nil, nil, "", nil, failf("the requester's key isn't a P-256 key: %v", err)
	}
	pt, err := crypto.OpenBlob(promptKey, "prompt", l.ID, pr.PromptCt)
	var p Prompt
	if err != nil || json.Unmarshal(pt, &p) != nil {
		return nil, nil, "", nil, failf("the request doesn't decrypt: the link or the server data was changed")
	}
	return &pr, &p, auth, spki, nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var d byte
	for i := range a {
		d |= a[i] ^ b[i]
	}
	return d == 0
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (a *App) printPrompt(p *Prompt, expires string) {
	w := a.Stderr
	title := deref(p.Title)
	if title == "" {
		title = "A request for a secret"
	}
	fmt.Fprintf(w, "“%s”", title)
	if from := deref(p.From); from != "" {
		fmt.Fprintf(w, " from %s", from)
	}
	fmt.Fprintln(w)
	if m := deref(p.Message); m != "" {
		fmt.Fprintln(w, "  "+strings.ReplaceAll(m, "\n", "\n  "))
	}
	if len(p.Fields) > 0 {
		fmt.Fprintln(w, "Asks for: "+strings.Join(p.Fields, ", "))
	}
	if p.Files {
		fmt.Fprintln(w, "Files are welcome.")
	}
	if expires != "" {
		fmt.Fprintln(w, "Open until "+localTime(expires)+".")
	}
}

func (a *App) showPrompt(l *Link) error {
	_, p, _, _, err := a.fetchPrompt(a.anon(l.Base), l)
	if err != nil {
		return err
	}
	if a.json {
		a.printJSON(map[string]any{"id": l.ID, "kind": "request", "title": p.Title, "from": p.From, "message": p.Message,
			"fields": p.Fields, "files": p.Files})
		return nil
	}
	a.printPrompt(p, "")
	fmt.Fprintf(a.Stdout, "Answer it with: cryptex answer '%s#%s' < answer.txt\n", l.Base+"/q/"+l.ID, l.Fragment)
	return nil
}

type answerResp struct {
	AnsweredAt   *string      `json:"answered_at"`
	EphemeralKey string       `json:"ephemeral_key"`
	Streams      []StreamDesc `json:"streams"`
	KeptUntil    string       `json:"kept_until"`
	ExpiresAt    string       `json:"expires_at"`
}

// openAnswer reads the answer to a request this CLI created.
func (a *App) openAnswer(server, id string, o openOpts) error {
	st, err := a.st()
	if err != nil {
		return err
	}
	der, err := st.Key(id)
	if err != nil {
		return err
	}
	if der == nil {
		return usagef("no private key for request %s in %s: only the CLI that created a request can read its answer", id, st.KeyPath(id))
	}
	priv, err := crypto.ParsePrivateKey(der)
	if err != nil {
		return failf("the key for %s is unreadable: %v", id, err)
	}
	r, _ := st.Receipt(id)
	c := a.client(server)
	auth := api.AuthBearer
	if r != nil && r.ManageToken != "" {
		auth = "Manage " + r.ManageToken
	}
	base := "/requests/" + id
	var ans answerResp
	for {
		if err := c.JSON(a.ctx, api.Call{Method: http.MethodGet, Path: base + "/answer", Auth: auth, Idempotent: true}, &ans); err != nil {
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status == http.StatusGone && r != nil {
				a.finalize(r, goneStatus(ae.Reason), nil)
			}
			return err
		}
		if ans.AnsweredAt != nil {
			break
		}
		if !o.wait {
			return &ExitError{Code: ExitNotFound, Msg: "No answer yet. Run `cryptex open " + id + " --wait` or `cryptex status --watch " + id + "` to wait for it."}
		}
		select {
		case <-a.ctx.Done():
			return a.ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	if o.as != "json" {
		if r != nil && r.Title != "" {
			fmt.Fprintf(a.Stderr, "Answer to “%s” (kept until %s)\n", r.Title, localTime(ans.KeptUntil))
		} else {
			fmt.Fprintf(a.Stderr, "Answer received %s (kept until %s)\n", localTime(deref(ans.AnsweredAt)), localTime(ans.KeptUntil))
		}
	}
	eph, err := crypto.UnB64u(ans.EphemeralKey)
	if err != nil {
		return failf("the server sent a malformed ephemeral key")
	}
	pub, err := crypto.ParseSPKI(eph)
	if err != nil {
		return failf("the answer's key isn't a P-256 key: %v", err)
	}
	key, err := crypto.AnswerKey(id, priv, pub)
	if err != nil {
		return err
	}
	hasFiles := false
	for _, s := range ans.Streams {
		hasFiles = hasFiles || s.Stream > 0
	}
	if hasFiles {
		if err := ensureOutDir(o.out); err != nil {
			return err
		}
	}
	d := &downloader{a: a, client: c, path: base + "/answer/chunks", auth: auth, key: key, id: id}
	items, err := d.payload(ans.Streams, o.out)
	if err != nil {
		return err
	}
	if r != nil {
		r.Status = "revealed"
		r.Link = ""
		r.CheckedAt = time.Now().UTC()
		_ = st.PutReceipt(r)
	}
	var title *string
	if r != nil {
		title = strPtr(r.Title)
	}
	return a.printOpened(Opened{ID: id, Kind: "answer", Title: title, Items: items}, o.as)
}

// ---------------------------------------------------------------- printing

func (a *App) printOpened(o Opened, as string) error {
	for _, it := range o.Items {
		if it.T == "file" && as != "json" {
			fmt.Fprintf(a.Stderr, "Saved %s (%s) to %s\n", it.Name, humanBytes(it.Size), it.Path)
		}
	}
	switch as {
	case "json":
		if o.Items == nil {
			o.Items = []OutItem{}
		}
		a.printJSON(o)
	case "env":
		fmt.Fprint(a.Stdout, FormatEnv(o.Items))
	default:
		fmt.Fprint(a.Stdout, FormatText(o.Items))
	}
	if o.ViewsLeft != nil && as != "json" {
		if *o.ViewsLeft == 0 {
			fmt.Fprintln(a.Stderr, "That was the last view: the secret is now deleted from the server.")
		} else {
			fmt.Fprintf(a.Stderr, "%s left.\n", plural(*o.ViewsLeft, "view"))
		}
	}
	return nil
}

// FormatText prints notes as they are and fields as "key: value".
func FormatText(items []OutItem) string {
	var b strings.Builder
	for _, it := range items {
		switch it.T {
		case "note":
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
				b.WriteByte('\n')
			}
			b.WriteString(it.V)
		case "field":
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
				b.WriteByte('\n')
			}
			if strings.Contains(it.V, "\n") {
				fmt.Fprintf(&b, "%s:\n%s\n", it.K, strings.TrimRight(it.V, "\n"))
			} else {
				fmt.Fprintf(&b, "%s: %s\n", it.K, it.V)
			}
		}
	}
	return b.String()
}

var (
	envKeyOK   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	envKeyBad  = regexp.MustCompile(`[^A-Za-z0-9]+`)
	envValueOK = regexp.MustCompile(`^[A-Za-z0-9_./:@%+,=-]*$`)
)

// EnvKey turns a field name into an environment variable name ("Access key ID" → ACCESS_KEY_ID).
func EnvKey(k string) string {
	if envKeyOK.MatchString(k) {
		return k
	}
	k = strings.Trim(envKeyBad.ReplaceAllString(strings.ToUpper(k), "_"), "_")
	if k == "" {
		return "FIELD"
	}
	if k[0] >= '0' && k[0] <= '9' {
		k = "_" + k
	}
	return k
}

// EnvValue quotes a value for a .env file when needed.
func EnvValue(v string) string {
	if envValueOK.MatchString(v) {
		return v
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", `\$`, "`", "\\`", "\n", `\n`, "\r", `\r`)
	return `"` + r.Replace(v) + `"`
}

// FormatEnv prints fields as KEY=value lines. Notes that parse as fields are converted;
// other notes become # comments so nothing is lost and the output stays a valid .env file.
func FormatEnv(items []OutItem) string {
	var b strings.Builder
	for _, it := range items {
		switch it.T {
		case "field":
			fmt.Fprintf(&b, "%s=%s\n", EnvKey(it.K), EnvValue(it.V))
		case "note":
			r := paste.Parse(it.V)
			if r.Rule == paste.RuleNote {
				for _, line := range strings.Split(strings.TrimRight(strings.ReplaceAll(it.V, "\r\n", "\n"), "\n"), "\n") {
					b.WriteString("# " + line + "\n")
				}
				continue
			}
			for _, f := range r.Fields {
				fmt.Fprintf(&b, "%s=%s\n", EnvKey(f.Key), EnvValue(f.Value))
			}
		case "file":
			fmt.Fprintf(&b, "# file: %s\n", it.Path)
		}
	}
	return b.String()
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%d %ss", n, word)
}

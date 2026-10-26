package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/polius/cryptex/cli/internal/api"
	"github.com/polius/cryptex/cli/internal/crypto"
	"github.com/polius/cryptex/cli/internal/paste"
	"github.com/polius/cryptex/cli/internal/store"
)

func (a *App) cmdRequest(args []string) error {
	fs := a.flags("request", "TITLE", "Create a request: a link someone uses to send you a secret, encrypted to a key only this CLI holds.\nThe private key is kept in the config directory under keys/ (0600).")
	var fields stringList
	fs.Var(&fields, "field", "a field to ask for (repeatable)")
	files := fs.Bool("files", false, "allow the responder to attach files")
	ttl := fs.String("ttl", "", "the link stays open this long: 1h, 1d, 7d… (default 7d, capped by the server)")
	keep := fs.String("keep", "", "keep the answer this long once received (default 7d, capped by the server)")
	message := fs.String("message", "", "a message shown to the responder")
	notify := fs.Bool("notify", false, "email me when it's answered")
	copyLink := fs.Bool("copy", false, "also copy the link to the clipboard")
	pos, err := fs.parse(args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || strings.TrimSpace(pos[0]) == "" {
		return usagef("usage: cryptex request TITLE [--field NAME]…")
	}
	title := strings.TrimSpace(pos[0])
	server, err := a.serverURL()
	if err != nil {
		return err
	}
	c := a.client(server)
	cfg, err := a.serverConfig(c)
	if err != nil {
		return err
	}
	expires := min(int64(7*86400), cfg.Limits.RequestMaxExpiresIn)
	if *ttl != "" {
		if expires, err = ParseDuration(*ttl); err != nil {
			return usagef("--ttl: %v", err)
		}
	}
	keepS := min(int64(7*86400), cfg.Limits.RequestMaxKeep)
	if *keep != "" {
		if keepS, err = ParseDuration(*keep); err != nil {
			return usagef("--keep: %v", err)
		}
	}
	if expires < 300 || keepS < 300 {
		return usagef("--ttl and --keep must be at least 5m")
	}
	if expires > cfg.Limits.RequestMaxExpiresIn {
		return usagef("--ttl %s is over this server's limit of %s", humanDuration(expires), humanDuration(cfg.Limits.RequestMaxExpiresIn))
	}
	if keepS > cfg.Limits.RequestMaxKeep {
		return usagef("--keep %s is over this server's limit of %s", humanDuration(keepS), humanDuration(cfg.Limits.RequestMaxKeep))
	}
	if fields == nil {
		fields = stringList{}
	}

	priv, err := crypto.GenerateP256()
	if err != nil {
		return err
	}
	spki := crypto.SPKI(priv.PublicKey())
	hdr, err := a.withPoW(c, cfg, nil)
	if err != nil {
		return err
	}
	var created struct {
		ID          string `json:"id"`
		ManageToken string `json:"manage_token"`
		UploadToken string `json:"upload_token"`
		ExpiresAt   string `json:"expires_at"`
	}
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: "/requests", Auth: api.AuthBearer, Header: hdr,
		JSON: map[string]any{"public_key": crypto.B64u(spki), "expires_in": expires, "keep_answer_s": keepS, "files": *files,
			"notify": *notify}}, &created); err != nil {
		return err
	}
	if !idRe.MatchString(created.ID) {
		return failf("the server returned an invalid ID %q", created.ID)
	}
	st, err := a.st()
	if err != nil {
		return err
	}
	// Keep the private key before the link exists, so an answer can never arrive for a lost key.
	if err := st.SaveKey(created.ID, crypto.MarshalPrivateKey(priv)); err != nil {
		cancelRequest(c, created.ID, created.ManageToken)
		return failf("couldn't save the private key: %v", err)
	}
	P := crypto.Random(16)
	rk := crypto.DeriveRequest(created.ID, P, spki)
	prompt, err := json.Marshal(Prompt{Title: &title, From: a.senderName(cfg), Message: strPtr(*message), Fields: fields, Files: *files})
	if err != nil {
		return err
	}
	seal := map[string]string{"prompt_ct": crypto.SealBlob(rk.PromptKey, "prompt", created.ID, prompt, nil),
		"answer_token_hash": rk.AnswerTokenHash()}
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: "/requests/" + created.ID + "/seal",
		Auth: "Upload " + created.UploadToken, JSON: seal, Idempotent: true}, nil); err != nil && !isCode(err, "already_sealed") {
		cancelRequest(c, created.ID, created.ManageToken)
		_ = st.DeleteKey(created.ID)
		return err
	}
	link := linkBase(server, cfg) + "/q/" + created.ID + "#" + rk.Fragment
	r := &store.Receipt{ID: created.ID, Kind: "request", Server: server, ManageToken: created.ManageToken, Link: link,
		Title: title, CreatedAt: time.Now().UTC(), ExpiresAt: created.ExpiresAt, Status: "waiting"}
	if err := st.PutReceipt(r); err != nil {
		a.warn("couldn't save the receipt (status won't know this item): %v", err)
	}
	if *copyLink {
		if err := copyToClipboard(link); err != nil {
			a.warn("%v", err)
		} else {
			a.info("Link copied to the clipboard.")
		}
	}
	if a.json {
		a.printJSON(map[string]any{"link": link, "id": created.ID, "expires_at": created.ExpiresAt, "keep": keepS,
			"key_file": st.KeyPath(created.ID)})
		return nil
	}
	fmt.Fprintln(a.Stdout, link)
	a.info("Read the answer with: cryptex open %s", created.ID)
	return nil
}

func cancelRequest(c *api.Client, id, manage string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, _, _ = c.Do(ctx, api.Call{Method: http.MethodDelete, Path: "/requests/" + id, Auth: "Manage " + manage})
}

func (a *App) cmdAnswer(args []string) error {
	fs := a.flags("answer", "LINK [file…]", "Answer a request link. The answer is encrypted to the requester's key before it leaves this machine.\nStdin is the answer: with requested fields it's parsed as KEY=value or `key: value` lines (a single\nrequested field takes the whole text). In a terminal you're asked for each field.")
	fieldsFlag := fs.Bool("fields", false, "parse stdin into fields even if the request didn't name any")
	note := fs.Bool("note", false, "send stdin as a note, without parsing it into fields")
	pos, err := fs.parse(args)
	if err != nil {
		return err
	}
	if len(pos) < 1 {
		return usagef("usage: cryptex answer LINK [file…] < answer")
	}
	l, err := ParseLink(pos[0])
	if err != nil {
		return err
	}
	if l.Kind != "q" {
		return usagef("that's a secret link, not a request link; use cryptex open")
	}
	if !l.HasFragment {
		return errIncomplete
	}
	if _, _, err := crypto.ParseRequestFragment(l.Fragment); err != nil {
		return errIncomplete
	}
	files := pos[1:]
	c := a.anon(l.Base)
	pr, p, auth, spki, err := a.fetchPrompt(c, l)
	if err != nil {
		return err
	}
	if !a.json {
		a.printPrompt(p, pr.ExpiresAt)
	}
	if len(files) > 0 && !pr.Files {
		return usagef("this request doesn't accept files")
	}

	var text []Item
	switch {
	case a.stdinIsTTY() && len(p.Fields) > 0 && !*note:
		for _, f := range p.Fields {
			var v string
			if paste.IsSecretKey(f) {
				v, err = a.promptSecret(f + ": ")
			} else {
				v, err = a.promptLine(f + ": ")
			}
			if err != nil {
				return usagef("can't prompt for %q: %v", f, err)
			}
			text = append(text, Item{T: "field", K: f, V: v, Secret: true})
		}
	case !a.stdinIsTTY() || len(files) == 0:
		s, err := a.readText(int64(pr.Limits.MaxMessageChars)*4+1, "Type or paste your answer, then press Ctrl-D (Ctrl-Z Enter on Windows):")
		if err != nil {
			return err
		}
		if s != "" {
			text = answerItems(s, p.Fields, *fieldsFlag, *note)
		}
	}
	ct, err := buildContent(text, files, pr.Limits.MaxFiles, pr.Limits.MaxFileBytes, pr.Limits.MaxMessageChars)
	if err != nil {
		return err
	}
	if missing := missingFields(p.Fields, text); len(missing) > 0 {
		a.warn("not answered: %s", strings.Join(missing, ", "))
	}

	reqPub, err := crypto.ParseSPKI(spki)
	if err != nil {
		return failf("the requester's key isn't a P-256 key: %v", err)
	}
	eph, err := crypto.GenerateP256()
	if err != nil {
		return err
	}
	key, err := crypto.AnswerKey(l.ID, eph, reqPub)
	if err != nil {
		return err
	}
	cfg := &ServerConfig{}
	var probe ServerConfig
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodGet, Path: "/config", Idempotent: true}, &probe); err == nil {
		cfg = &probe
	}
	hdr, err := a.withPoW(c, cfg, nil)
	if err != nil {
		return err
	}
	var started struct {
		UploadToken string `json:"upload_token"`
	}
	base := "/requests/" + l.ID + "/answer"
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: base, Auth: auth, Header: hdr,
		JSON: map[string]any{"ephemeral_key": crypto.B64u(crypto.SPKI(eph.PublicKey())), "streams": ct.descs()}}, &started); err != nil {
		return err
	}
	upAuth := "Upload " + started.UploadToken
	up := &uploader{a: a, client: c, path: base + "/chunks", auth: upAuth, key: key, id: l.ID}
	if err := up.upload(ct.sources); err != nil {
		return err
	}
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: base + "/seal", Auth: upAuth, Idempotent: true}, nil); err != nil &&
		!isCode(err, "already_answered") {
		return err
	}
	if a.json {
		a.printJSON(map[string]any{"id": l.ID, "answered": true, "items": len(ct.items)})
		return nil
	}
	fmt.Fprintln(a.Stdout, "Answer sent. Only the requester can read it.")
	return nil
}

// answerItems turns stdin into the answer's items, matching requested field names case-insensitively.
func answerItems(s string, requested []string, forceFields, forceNote bool) []Item {
	if forceNote {
		return []Item{{T: "note", V: s}}
	}
	if len(requested) == 0 && !forceFields {
		return []Item{{T: "note", V: s}}
	}
	r := paste.Parse(s)
	if r.Rule == paste.RuleNote || (len(requested) == 1 && !anyKeyMatches(r.Fields, requested)) {
		if len(requested) == 1 {
			return []Item{{T: "field", K: requested[0], V: strings.TrimRight(s, "\r\n"), Secret: true}}
		}
		return []Item{{T: "note", V: s}}
	}
	out := make([]Item, 0, len(r.Fields))
	for _, f := range r.Fields {
		k := f.Key
		for _, want := range requested {
			if strings.EqualFold(strings.TrimSpace(want), k) || EnvKey(want) == EnvKey(k) {
				k = want
				break
			}
		}
		out = append(out, Item{T: "field", K: k, V: f.Value, Secret: f.Secret || paste.IsSecretKey(k)})
	}
	return out
}

func anyKeyMatches(fs []paste.Field, requested []string) bool {
	for _, f := range fs {
		for _, w := range requested {
			if strings.EqualFold(w, f.Key) || EnvKey(w) == EnvKey(f.Key) {
				return true
			}
		}
	}
	return false
}

func missingFields(requested []string, items []Item) []string {
	have := map[string]bool{}
	for _, it := range items {
		if it.T == "field" {
			have[it.K] = true
		}
	}
	var out []string
	for _, f := range requested {
		if !have[f] {
			out = append(out, f)
		}
	}
	if len(items) > 0 && len(out) == len(requested) {
		return nil // answered with a note or files instead: nothing specific to point out
	}
	return out
}

// Package app implements the cryptex commands (design/v3/spec/cli.md).
package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/polius/cryptex/cli/internal/api"
	"github.com/polius/cryptex/cli/internal/crypto"
	"github.com/polius/cryptex/cli/internal/store"
)

// Version is set at build time with -ldflags "-X github.com/polius/cryptex/cli/internal/app.Version=…".
var Version = "dev"

// Exit codes (cli.md).
const (
	ExitOK         = 0
	ExitUsage      = 1
	ExitServer     = 2
	ExitNotFound   = 3
	ExitGone       = 4
	ExitPassphrase = 5
	ExitRateLimit  = 6
	ExitIncomplete = 7
)

// ExitError carries an exit code and a human message.
type ExitError struct {
	Code int
	Msg  string
	Err  error
}

func (e *ExitError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	return "error"
}

func (e *ExitError) Unwrap() error { return e.Err }

func usagef(format string, a ...any) error {
	return &ExitError{Code: ExitUsage, Msg: fmt.Sprintf(format, a...)}
}

func failf(format string, a ...any) error {
	return &ExitError{Code: ExitServer, Msg: fmt.Sprintf(format, a...)}
}

var errIncomplete = &ExitError{Code: ExitIncomplete, Msg: "This link is incomplete: the part after # is missing or cut off. Ask the sender to copy the whole link again.", Err: crypto.ErrIncompleteLink}

// App holds the I/O and options for one invocation.
type App struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer

	json    bool
	server  string // --server
	verbose bool
	store   *store.Store
	ctx     context.Context
}

// Main runs the CLI and returns the process exit code.
func Main(args []string) int {
	a := &App{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	a.ctx = ctx
	return a.Run(args)
}

type command struct {
	name, args, summary string
	run                 func(a *App, args []string) error
}

var commands []command

func init() {
	commands = []command{
		{"login", "[server]", "Store an API token for a server (opens the browser, or --with-token reads stdin)", (*App).cmdLogin},
		{"logout", "", "Remove the stored API token", (*App).cmdLogout},
		{"send", "[file…]", "Encrypt stdin and/or files, upload them and print the link", (*App).cmdSend},
		{"request", "TITLE", "Ask someone for a secret; prints a link for them to answer", (*App).cmdRequest},
		{"answer", "LINK [file…]", "Answer a request link with stdin and/or files", (*App).cmdAnswer},
		{"open", "LINK|ID", "Reveal a secret, or read the answer to your request", (*App).cmdOpen},
		{"status", "[ID…]", "Show the status of items created by this CLI (--watch to follow)", (*App).cmdStatus},
		{"destroy", "ID", "Destroy a secret or cancel a request now", (*App).cmdDestroy},
		{"ls", "", "List items created by this CLI", (*App).cmdLs},
		{"version", "", "Print the version", (*App).cmdVersion},
	}
}

func (a *App) usage(w io.Writer) {
	fmt.Fprintf(w, "cryptex %s: share secrets through a Cryptex server, end-to-end encrypted.\n\nUsage:\n", Version)
	for _, c := range commands {
		fmt.Fprintf(w, "  cryptex %-8s %-13s %s\n", c.name, c.args, c.summary)
	}
	fmt.Fprint(w, `
Global flags: --json (machine output), --server URL, -v (verbose)
Environment:  CRYPTEX_SERVER, CRYPTEX_TOKEN, CRYPTEX_PASSPHRASE, CRYPTEX_CONFIG_DIR, CRYPTEX_NO_PROMPT=1
Exit codes:   0 ok · 1 usage · 2 network or server · 3 not found · 4 gone · 5 wrong passphrase
              6 rate limited · 7 link incomplete

Run "cryptex COMMAND --help" for a command's flags.
`)
}

// Run dispatches a command and returns the exit code.
func (a *App) Run(args []string) int {
	if a.ctx == nil {
		a.ctx = context.Background()
	}
	if len(args) == 0 {
		a.usage(a.Stderr)
		return ExitUsage
	}
	name := args[0]
	switch name {
	case "-h", "--help", "help":
		a.usage(a.Stdout)
		return ExitOK
	case "-V", "--version":
		name = "version"
	}
	for _, c := range commands {
		if c.name == name {
			err := c.run(a, args[1:])
			return a.finish(err)
		}
	}
	fmt.Fprintf(a.Stderr, "cryptex: unknown command %q\n\n", name)
	a.usage(a.Stderr)
	return ExitUsage
}

func (a *App) finish(err error) int {
	if err == nil {
		return ExitOK
	}
	if errors.Is(err, flag.ErrHelp) {
		return ExitOK
	}
	code, msg, extra := describe(err)
	if a.json {
		e := map[string]any{"code": "error", "message": msg, "exit": code}
		var ae *api.Error
		if errors.As(err, &ae) {
			e["code"] = ae.Code
			if ae.Reason != "" {
				e["reason"] = ae.Reason
			}
			if ae.TriesLeft != nil {
				e["tries_left"] = *ae.TriesLeft
			}
			if ae.RetryAfter > 0 {
				e["retry_after"] = ae.RetryAfter
			}
		} else if code == ExitIncomplete {
			e["code"] = "incomplete_link"
		}
		a.printJSON(map[string]any{"error": e})
	} else {
		fmt.Fprintln(a.Stderr, "cryptex: "+msg)
		if extra != "" {
			fmt.Fprintln(a.Stderr, extra)
		}
	}
	return code
}

var goneReasons = map[string]string{
	"opened":         "it was already opened",
	"expired":        "it expired",
	"destroyed":      "it was destroyed",
	"cancelled":      "it was cancelled",
	"answered":       "it was already answered",
	"too_many_tries": "it was destroyed after too many wrong tries",
}

// describe maps an error to (exit code, message, hint).
func describe(err error) (int, string, string) {
	var xe *ExitError
	if errors.As(err, &xe) {
		return xe.Code, xe.Error(), ""
	}
	if errors.Is(err, crypto.ErrIncompleteLink) {
		return ExitIncomplete, errIncomplete.Msg, ""
	}
	if errors.Is(err, context.Canceled) {
		return ExitServer, "interrupted", ""
	}
	var ae *api.Error
	if errors.As(err, &ae) {
		switch {
		case ae.Status == http.StatusNotFound:
			return ExitNotFound, "Not found: the link or ID is wrong, or you don't hold its token.", ""
		case ae.Status == http.StatusGone:
			why := goneReasons[ae.Reason]
			if why == "" {
				why = "it's no longer available"
			}
			msg := "Gone: " + why
			if ae.At != "" {
				msg += " (" + localTime(ae.At) + ")"
			}
			return ExitGone, msg + ".", ""
		case ae.Code == "wrong_passphrase":
			msg := "Wrong passphrase."
			if ae.TriesLeft != nil {
				msg += fmt.Sprintf(" %d tries left before the secret is destroyed.", *ae.TriesLeft)
			}
			return ExitPassphrase, msg, ""
		case ae.Status == http.StatusTooManyRequests:
			msg := ae.Error()
			if ae.RetryAfter > 0 && !strings.Contains(msg, "Try again in") {
				msg += fmt.Sprintf(" Try again in %s.", (time.Duration(ae.RetryAfter) * time.Second).String())
			}
			return ExitRateLimit, "Rate limited: " + msg, ""
		case ae.Code == "sign_in_required":
			return ExitServer, ae.Error(), "Run `cryptex login` to store an API token for this server."
		}
		return ExitServer, "The server refused: " + ae.Error(), ""
	}
	var ne *api.NetError
	if errors.As(err, &ne) {
		return ExitServer, ne.Error(), ""
	}
	if errors.Is(err, crypto.ErrTampered) {
		return ExitServer, err.Error(), ""
	}
	return ExitServer, err.Error(), ""
}

// ---------------------------------------------------------------- flags

type flagSet struct {
	*flag.FlagSet
	a *App
}

type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ", ") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

func (a *App) flags(name, args, help string) *flagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.BoolVar(&a.json, "json", false, "print one JSON object per result")
	fs.StringVar(&a.server, "server", "", "server URL (overrides CRYPTEX_SERVER and config.toml)")
	fs.BoolVar(&a.verbose, "v", false, "verbose: show retries")
	fs.Usage = func() {
		fmt.Fprintf(a.Stdout, "Usage: cryptex %s %s\n\n%s\n\nFlags:\n", name, args, help)
		fs.SetOutput(a.Stdout)
		fs.PrintDefaults()
		fs.SetOutput(io.Discard)
	}
	return &flagSet{FlagSet: fs, a: a}
}

// parse accepts flags before, between and after positional arguments ("--" ends flags).
func (fs *flagSet) parse(args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				fs.Usage()
				return nil, flag.ErrHelp
			}
			return nil, usagef("%v (see cryptex %s --help)", err, fs.Name())
		}
		rest := fs.Args()
		if len(rest) == 0 {
			return pos, nil
		}
		// flag stops at "--" too; if the previous arg was "--", everything left is positional.
		if n := len(args) - len(rest); n > 0 && args[n-1] == "--" {
			return append(pos, rest...), nil
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

// ---------------------------------------------------------------- environment

func (a *App) st() (*store.Store, error) {
	if a.store == nil {
		s, err := store.Open()
		if err != nil {
			return nil, err
		}
		a.store = s
	}
	return a.store, nil
}

// NormalizeServer turns "vault.acme.com" or "https://vault.acme.com/api/v1/" into "https://vault.acme.com".
func NormalizeServer(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", usagef("empty server URL")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", usagef("not a server URL: %q", s)
	}
	p := strings.TrimRight(u.Path, "/")
	p = strings.TrimSuffix(p, "/api/v1")
	return u.Scheme + "://" + u.Host + strings.TrimRight(p, "/"), nil
}

// serverURL resolves --server, CRYPTEX_SERVER, then config.toml.
func (a *App) serverURL() (string, error) {
	if a.server != "" {
		return NormalizeServer(a.server)
	}
	if s := os.Getenv("CRYPTEX_SERVER"); s != "" {
		return NormalizeServer(s)
	}
	st, err := a.st()
	if err != nil {
		return "", err
	}
	cfg, err := st.Config()
	if err != nil {
		return "", &ExitError{Code: ExitUsage, Err: err, Msg: err.Error()}
	}
	if cfg["server"] == "" {
		return "", usagef("no server set. Run `cryptex login https://your-server`, or set CRYPTEX_SERVER")
	}
	return NormalizeServer(cfg["server"])
}

// token resolves CRYPTEX_TOKEN, then the stored token for the server.
func (a *App) token(server string) string {
	if t := os.Getenv("CRYPTEX_TOKEN"); t != "" {
		return strings.TrimSpace(t)
	}
	st, err := a.st()
	if err != nil {
		return ""
	}
	t, _ := st.Token(server)
	return t
}

func (a *App) client(server string) *api.Client {
	c := api.New(server, a.token(server), "cryptex-cli/"+Version)
	if a.verbose {
		c.Verbose = func(f string, x ...any) { fmt.Fprintf(a.Stderr, "cryptex: "+f+"\n", x...) }
	}
	return c
}

// ServerConfig is GET /config.
type ServerConfig struct {
	Version     string `json:"version"`
	Mode        string `json:"mode"`
	Demo        bool   `json:"demo"`
	SetupNeeded bool   `json:"setup_needed"`
	User        *struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	Via   *string `json:"via"`
	Brand struct {
		Name      string `json:"name"`
		PublicURL string `json:"public_url"`
	} `json:"brand"`
	Limits struct {
		MaxExpiresIn        int64 `json:"max_expires_in"`
		MaxViews            int   `json:"max_views"`
		MaxMessageChars     int   `json:"max_message_chars"`
		MaxFiles            int   `json:"max_files"`
		MaxFileBytes        int64 `json:"max_file_bytes"`
		RequestMaxExpiresIn int64 `json:"request_max_expires_in"`
		RequestMaxKeep      int64 `json:"request_max_keep"`
	} `json:"limits"`
	Defaults struct {
		Views     int   `json:"views"`
		ExpiresIn int64 `json:"expires_in"`
	} `json:"defaults"`
	Features struct {
		EmailAccess bool `json:"email_access"`
		OrgAccess   bool `json:"org_access"`
		Notify      bool `json:"notify"`
	} `json:"features"`
}

func (a *App) serverConfig(c *api.Client) (*ServerConfig, error) {
	var cfg ServerConfig
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodGet, Path: "/config", Auth: api.AuthBearer, Idempotent: true}, &cfg); err != nil {
		return nil, err
	}
	if cfg.SetupNeeded {
		return nil, failf("this server isn't set up yet; finish setup in the browser first")
	}
	return &cfg, nil
}

// linkBase is the origin used in links: the server's public URL when it reports one.
func linkBase(server string, cfg *ServerConfig) string {
	if cfg != nil && cfg.Brand.PublicURL != "" {
		if s, err := NormalizeServer(cfg.Brand.PublicURL); err == nil {
			return s
		}
	}
	return server
}

func (a *App) senderName(cfg *ServerConfig) *string {
	if cfg.User == nil {
		return nil
	}
	n := cfg.User.Name
	if n == "" {
		n = cfg.User.Email
	}
	return &n
}

// ---------------------------------------------------------------- links

var idRe = regexp.MustCompile(`^[0-9A-Za-z]{10}$`)

// Link is a parsed Cryptex link.
type Link struct {
	Base        string // origin (+ path prefix) of the server
	Kind        string // "s" or "q"
	ID          string
	Fragment    string
	HasFragment bool
}

// ParseLink parses https://host/s/ID#K or https://host/q/ID#P. It doesn't validate the fragment.
func ParseLink(s string) (*Link, error) {
	s = strings.TrimSpace(s)
	raw, frag, has := strings.Cut(s, "#")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, usagef("not a Cryptex link: %q", raw)
	}
	p := strings.TrimRight(u.Path, "/")
	for _, kind := range []string{"s", "q"} {
		i := strings.LastIndex(p, "/"+kind+"/")
		if i < 0 {
			continue
		}
		id := p[i+3:]
		if !idRe.MatchString(id) {
			return nil, usagef("not a Cryptex link: the ID %q isn't 10 letters and digits", id)
		}
		return &Link{Base: u.Scheme + "://" + u.Host + p[:i], Kind: kind, ID: id, Fragment: frag, HasFragment: has}, nil
	}
	return nil, usagef("not a Cryptex link (expected …/s/ID#key or …/q/ID#key): %q", raw)
}

// ---------------------------------------------------------------- output

func (a *App) printJSON(v any) {
	enc := json.NewEncoder(a.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func (a *App) info(format string, x ...any) {
	if !a.json {
		fmt.Fprintf(a.Stderr, format+"\n", x...)
	}
}

func (a *App) warn(format string, x ...any) {
	fmt.Fprintf(a.Stderr, "cryptex: "+format+"\n", x...)
}

func localTime(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	return t.Local().Format("2006-01-02 15:04")
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// ParseDuration accepts 90s, 30m, 1h, 1d, 2w (and combinations like 1d12h) and returns seconds.
func ParseDuration(s string) (int64, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 0, errors.New("empty duration")
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n, nil
	}
	re := regexp.MustCompile(`(\d+)([smhdw])`)
	if re.ReplaceAllString(s, "") != "" {
		return 0, fmt.Errorf("can't read duration %q (use 30m, 1h, 1d, 7d)", s)
	}
	unit := map[string]int64{"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 7 * 86400}
	var total int64
	for _, m := range re.FindAllStringSubmatch(s, -1) {
		n, _ := strconv.ParseInt(m[1], 10, 64)
		total += n * unit[m[2]]
	}
	return total, nil
}

func humanDuration(sec int64) string {
	switch {
	case sec%86400 == 0:
		return fmt.Sprintf("%dd", sec/86400)
	case sec%3600 == 0:
		return fmt.Sprintf("%dh", sec/3600)
	case sec%60 == 0:
		return fmt.Sprintf("%dm", sec/60)
	}
	return fmt.Sprintf("%ds", sec)
}

func (a *App) cmdVersion(args []string) error {
	fs := a.flags("version", "", "Print the version.")
	if _, err := fs.parse(args); err != nil {
		return err
	}
	if a.json {
		a.printJSON(map[string]string{"version": Version})
		return nil
	}
	fmt.Fprintln(a.Stdout, "cryptex "+Version)
	return nil
}

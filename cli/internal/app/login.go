package app

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/polius/cryptex/cli/internal/api"
)

func (a *App) cmdLogin(args []string) error {
	fs := a.flags("login", "[server]", "Store a personal API token for a server. Without --with-token, opens {server}/tokens in the\nbrowser so you can create one, then asks you to paste it.")
	withToken := fs.Bool("with-token", false, "read the token from stdin")
	pos, err := fs.parse(args)
	if err != nil {
		return err
	}
	if len(pos) > 1 {
		return usagef("usage: cryptex login [server] [--with-token]")
	}
	st, err := a.st()
	if err != nil {
		return err
	}
	var server string
	if len(pos) == 1 {
		if server, err = NormalizeServer(pos[0]); err != nil {
			return err
		}
	} else if server, err = a.serverURL(); err != nil {
		return usagef("which server? Run cryptex login https://your-server")
	}

	var token string
	if *withToken {
		b, err := io.ReadAll(io.LimitReader(a.Stdin, 4096))
		if err != nil {
			return usagef("reading the token from stdin: %v", err)
		}
		token = strings.TrimSpace(string(b))
	} else {
		u := server + "/tokens"
		a.info("Create a token in your browser: %s", u)
		openBrowser(u)
		token, err = a.promptSecret("Paste the token: ")
		if err != nil {
			return usagef("no terminal to paste into; use: cryptex login %s --with-token < token.txt", server)
		}
		token = strings.TrimSpace(token)
	}
	if token == "" {
		return usagef("empty token")
	}
	if !strings.HasPrefix(token, "cx_") {
		a.warn("that doesn't look like a Cryptex token (they start with cx_live_); trying anyway")
	}

	c := api.New(server, token, "cryptex-cli/"+Version)
	var cfg ServerConfig
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodGet, Path: "/config", Auth: api.AuthBearer, Idempotent: true}, &cfg); err != nil {
		if isCode(err, "sign_in_required") {
			return failf("the server rejected that token (revoked, expired or mistyped)")
		}
		return err
	}
	if cfg.User == nil {
		return failf("the server didn't accept that token")
	}
	where, err := st.SetToken(server, token)
	if err != nil {
		return failf("couldn't store the token: %v", err)
	}
	if err := st.SetConfig("server", server); err != nil {
		return failf("couldn't save config.toml: %v", err)
	}
	if a.json {
		a.printJSON(map[string]any{"server": server, "email": cfg.User.Email, "name": cfg.User.Name, "stored_in": where})
		return nil
	}
	fmt.Fprintf(a.Stdout, "Logged in to %s as %s.\n", server, cfg.User.Email)
	a.info("Token stored in %s.", where)
	return nil
}

func (a *App) cmdLogout(args []string) error {
	fs := a.flags("logout", "", "Remove the stored API token for the current server.")
	if _, err := fs.parse(args); err != nil {
		return err
	}
	server, err := a.serverURL()
	if err != nil {
		return err
	}
	st, err := a.st()
	if err != nil {
		return err
	}
	found, err := st.DeleteToken(server)
	if err != nil {
		return failf("couldn't remove the token: %v", err)
	}
	if a.json {
		a.printJSON(map[string]any{"server": server, "removed": found})
		return nil
	}
	if found {
		fmt.Fprintf(a.Stdout, "Logged out of %s.\n", server)
	} else {
		fmt.Fprintf(a.Stdout, "No token was stored for %s.\n", server)
	}
	return nil
}

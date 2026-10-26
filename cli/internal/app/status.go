package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/polius/cryptex/cli/internal/api"
	"github.com/polius/cryptex/cli/internal/store"
)

// ReceiptStatus is GET /receipts/{id}.
type ReceiptStatus struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Status     string `json:"status"`
	ViewsLeft  *int   `json:"views_left"`
	MaxViews   int    `json:"max_views,omitempty"`
	CreatedAt  string `json:"created_at,omitempty"`
	ExpiresAt  string `json:"expires_at,omitempty"`
	AnsweredAt string `json:"answered_at,omitempty"`
	KeptUntil  string `json:"kept_until,omitempty"`
	Reason     string `json:"reason,omitempty"`
	EndedAt    string `json:"ended_at,omitempty"`
	Events     []struct {
		Type   string         `json:"type"`
		At     string         `json:"at"`
		Detail map[string]any `json:"detail"`
	} `json:"events,omitempty"`
}

// finalStatus reports whether an item can't change any more (its link key is then dropped).
func finalStatus(kind, status string, viewsLeft *int, tombstone bool) bool {
	if tombstone {
		return true
	}
	switch status {
	case "expired", "destroyed", "cancelled":
		return true
	case "opened":
		return kind == "secret" && viewsLeft != nil && *viewsLeft == 0
	}
	return false
}

// watchDone reports whether --watch has nothing more to wait for on an item.
func watchDone(kind, status string, viewsLeft *int) bool {
	if kind == "request" {
		return status != "waiting" && status != ""
	}
	return finalStatus(kind, status, viewsLeft, false)
}

func goneStatus(reason string) string {
	switch reason {
	case "opened":
		return "opened"
	case "expired":
		return "expired"
	case "cancelled":
		return "cancelled"
	case "answered":
		return "revealed"
	}
	return "destroyed"
}

// finalize records a status; for final ones it drops the link key and the request's private key.
func (a *App) finalize(r *store.Receipt, status string, viewsLeft *int) {
	st, err := a.st()
	if err != nil {
		return
	}
	r.Status = status
	if viewsLeft != nil {
		r.ViewsLeft = viewsLeft
	}
	r.CheckedAt = time.Now().UTC()
	if r.ManageToken == "" {
		return // looked up through the API token; not one of this CLI's receipts
	}
	tomb := status == "destroyed" || status == "expired" || status == "cancelled"
	if finalStatus(r.Kind, status, r.ViewsLeft, tomb) || (r.Kind == "request" && status != "waiting") {
		r.Link = "" // the link (and its key) is useless now
	}
	if r.Kind == "request" && tomb {
		if err := st.DeleteKey(r.ID); err != nil {
			a.warn("couldn't delete the key for %s: %v", r.ID, err)
		}
	}
	if err := st.PutReceipt(r); err != nil {
		a.warn("couldn't update receipts: %v", err)
	}
}

func (a *App) fetchStatus(r *store.Receipt) (*ReceiptStatus, error) {
	c := a.client(r.Server)
	auth := api.AuthBearer
	if r.ManageToken != "" {
		auth = "Manage " + r.ManageToken
	}
	var rs ReceiptStatus
	if err := c.JSON(a.ctx, api.Call{Method: http.MethodGet, Path: "/receipts/" + r.ID, Auth: auth, Idempotent: true}, &rs); err != nil {
		return nil, err
	}
	a.finalize(r, rs.Status, rs.ViewsLeft)
	if rs.Reason != "" && r.Kind == "request" {
		_ = a.store.DeleteKey(r.ID)
	}
	return &rs, nil
}

// selectReceipts returns the receipts named by ID (or all). Unknown IDs get a stub that uses the API token.
func (a *App) selectReceipts(ids []string) ([]*store.Receipt, error) {
	st, err := a.st()
	if err != nil {
		return nil, err
	}
	all, err := st.Receipts()
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return all, nil
	}
	var out []*store.Receipt
	for _, id := range ids {
		var found *store.Receipt
		for _, r := range all {
			if r.ID == id {
				found = r
			}
		}
		if found == nil {
			if !idRe.MatchString(id) {
				return nil, usagef("not an ID: %q", id)
			}
			server, err := a.serverURL()
			if err != nil {
				return nil, err
			}
			if a.token(server) == "" {
				return nil, &ExitError{Code: ExitNotFound, Msg: id + " isn't in this CLI's receipts (and no API token is set to look it up)"}
			}
			found = &store.Receipt{ID: id, Server: server}
		}
		out = append(out, found)
	}
	return out, nil
}

func (a *App) cmdStatus(args []string) error {
	fs := a.flags("status", "[ID…]", "Show the status of secrets and requests created by this CLI (all of them if no ID is given).")
	watch := fs.Bool("watch", false, "follow live updates until every item is opened, answered or gone")
	ids, err := fs.parse(args)
	if err != nil {
		return err
	}
	rs, err := a.selectReceipts(ids)
	if err != nil {
		return err
	}
	if len(rs) == 0 {
		a.info("No items yet. Create one with cryptex send or cryptex request.")
		return nil
	}
	var firstErr error
	var tw *tabwriter.Writer
	if !a.json {
		tw = tabwriter.NewWriter(a.Stdout, 2, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tKIND\tSTATUS\tVIEWS LEFT\tEXPIRES\tTITLE")
	}
	var statuses []*ReceiptStatus
	for _, r := range rs {
		s, err := a.fetchStatus(r)
		if err != nil {
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status == http.StatusNotFound && len(ids) == 0 {
				// Tombstones are purged after 7 days; keep the last known status.
				s = &ReceiptStatus{ID: r.ID, Kind: r.Kind, Status: r.Status, ViewsLeft: r.ViewsLeft, ExpiresAt: r.ExpiresAt}
				if s.Status == "waiting" {
					a.finalize(r, "expired", nil)
					s.Status = "expired"
				}
			} else {
				if firstErr == nil {
					firstErr = err
				}
				if a.json {
					code, msg, _ := describe(err)
					a.printJSON(map[string]any{"id": r.ID, "error": map[string]any{"message": msg, "exit": code}})
				} else {
					_, msg, _ := describe(err)
					fmt.Fprintf(tw, "%s\t%s\t%s\t\t\t%s\n", r.ID, r.Kind, "error: "+msg, r.Title)
				}
				continue
			}
		}
		if s.Kind == "" {
			s.Kind = r.Kind
		}
		r.Kind = s.Kind
		statuses = append(statuses, s)
		if a.json {
			out := map[string]any{"id": s.ID, "kind": s.Kind, "status": s.Status, "views_left": s.ViewsLeft,
				"expires_at": strPtr(s.ExpiresAt), "title": strPtr(r.Title)}
			if s.Reason != "" {
				out["reason"], out["ended_at"] = s.Reason, s.EndedAt
			}
			if s.AnsweredAt != "" {
				out["answered_at"], out["kept_until"] = s.AnsweredAt, s.KeptUntil
			}
			if len(ids) > 0 {
				out["events"] = s.Events
			}
			a.printJSON(out)
			continue
		}
		views := ""
		if s.Kind == "secret" && s.ViewsLeft != nil {
			views = fmt.Sprint(*s.ViewsLeft)
			if s.MaxViews > 0 {
				views += fmt.Sprintf("/%d", s.MaxViews)
			}
		}
		exp := ""
		if s.ExpiresAt != "" && !finalStatus(s.Kind, s.Status, s.ViewsLeft, s.Reason != "") {
			exp = localTime(s.ExpiresAt)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", s.ID, s.Kind, s.Status, views, exp, r.Title)
	}
	if tw != nil {
		tw.Flush()
		if len(ids) == 1 && len(statuses) == 1 {
			for _, e := range statuses[0].Events {
				fmt.Fprintf(a.Stdout, "  %s  %s%s\n", localTime(e.At), e.Type, eventDetail(e.Detail))
			}
		}
	}
	if *watch {
		return a.watch(rs, statuses)
	}
	return firstErr
}

func eventDetail(d map[string]any) string {
	if len(d) == 0 {
		return ""
	}
	keys := make([]string, 0, len(d))
	for k := range d {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, d[k]))
	}
	return "  (" + strings.Join(parts, ", ") + ")"
}

// watch follows /receipts/events until every item is done.
func (a *App) watch(rs []*store.Receipt, statuses []*ReceiptStatus) error {
	byID := map[string]*store.Receipt{}
	pending := map[string]bool{}
	for _, s := range statuses {
		if !watchDone(s.Kind, s.Status, s.ViewsLeft) && s.Reason == "" {
			pending[s.ID] = true
		}
	}
	for _, r := range rs {
		byID[r.ID] = r
	}
	if len(pending) == 0 {
		a.info("Nothing left to watch.")
		return nil
	}
	// Group by server: one subscription each. Items without a manage token use the API token's account.
	servers := map[string][]map[string]string{}
	for id := range pending {
		r := byID[id]
		if r.ManageToken != "" {
			servers[r.Server] = append(servers[r.Server], map[string]string{"id": id, "manage_token": r.ManageToken})
		}
	}
	if len(servers) != 1 {
		if len(servers) == 0 {
			return usagef("--watch needs items created by this CLI")
		}
		return usagef("--watch follows one server at a time; pass IDs from one server")
	}
	var server string
	var items []map[string]string
	for s, it := range servers {
		server, items = s, it
	}
	c := a.client(server)
	a.info("Watching %d item(s). Press Ctrl-C to stop.", len(items))
	lastID := ""
	backoff := time.Second
	for len(pending) > 0 {
		var sub struct {
			Ticket string `json:"ticket"`
		}
		if err := c.JSON(a.ctx, api.Call{Method: http.MethodPost, Path: "/receipts/subscribe", JSON: map[string]any{"items": items}, Idempotent: true}, &sub); err != nil {
			return err
		}
		connected := time.Now()
		err := c.Events(a.ctx, "/receipts/events?ticket="+sub.Ticket, lastID, func(ev api.Event) error {
			if ev.ID != "" {
				lastID = ev.ID
			}
			if ev.Event != "receipt" {
				return nil
			}
			var d struct {
				Kind      string  `json:"kind"`
				ID        string  `json:"id"`
				Status    *string `json:"status"`
				ViewsLeft *int    `json:"views_left"`
				Event     struct {
					Type string `json:"type"`
					At   string `json:"at"`
				} `json:"event"`
			}
			if json.Unmarshal([]byte(ev.Data), &d) != nil || d.Status == nil {
				return nil
			}
			r := byID[d.ID]
			if r == nil {
				return nil
			}
			a.finalize(r, *d.Status, d.ViewsLeft)
			if a.json {
				a.printJSON(map[string]any{"id": d.ID, "kind": d.Kind, "status": *d.Status, "views_left": d.ViewsLeft,
					"event": d.Event.Type, "at": d.Event.At})
			} else {
				extra := ""
				if d.ViewsLeft != nil {
					extra = "  (" + plural(*d.ViewsLeft, "view") + " left)"
				}
				fmt.Fprintf(a.Stdout, "%s  %s  %s%s\n", localTime(d.Event.At), d.ID, *d.Status, extra)
			}
			if watchDone(d.Kind, *d.Status, d.ViewsLeft) {
				delete(pending, d.ID)
			}
			if len(pending) == 0 {
				return errWatchDone
			}
			return nil
		})
		if errors.Is(err, errWatchDone) {
			return nil
		}
		if a.ctx.Err() != nil {
			return nil
		}
		var ae *api.Error
		if errors.As(err, &ae) && ae.Status != http.StatusNotFound {
			return err
		}
		if time.Since(connected) > time.Minute {
			backoff = time.Second
		}
		select {
		case <-a.ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
	return nil
}

var errWatchDone = errors.New("done")

func (a *App) cmdLs(args []string) error {
	fs := a.flags("ls", "", "List secrets and requests created by this CLI, with their last known status (no network).")
	if _, err := fs.parse(args); err != nil {
		return err
	}
	st, err := a.st()
	if err != nil {
		return err
	}
	rs, err := st.Receipts()
	if err != nil {
		return err
	}
	if a.json {
		for _, r := range rs {
			a.printJSON(map[string]any{"id": r.ID, "kind": r.Kind, "server": r.Server, "title": r.Title, "status": r.Status,
				"views_left": r.ViewsLeft, "created_at": r.CreatedAt, "expires_at": r.ExpiresAt})
		}
		return nil
	}
	if len(rs) == 0 {
		a.info("No items yet. Create one with cryptex send or cryptex request.")
		return nil
	}
	tw := tabwriter.NewWriter(a.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tKIND\tSTATUS\tCREATED\tTITLE")
	for _, r := range rs {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", r.ID, r.Kind, r.Status, r.CreatedAt.Local().Format("2006-01-02 15:04"), r.Title)
	}
	return tw.Flush()
}

func (a *App) cmdDestroy(args []string) error {
	fs := a.flags("destroy", "ID", "Destroy a secret, or cancel a request (and delete its answer), right now.")
	ids, err := fs.parse(args)
	if err != nil {
		return err
	}
	if len(ids) != 1 {
		return usagef("usage: cryptex destroy ID")
	}
	rs, err := a.selectReceipts(ids)
	if err != nil {
		return err
	}
	r := rs[0]
	c := a.client(r.Server)
	auth := api.AuthBearer
	if r.ManageToken != "" {
		auth = "Manage " + r.ManageToken
	}
	kinds := []string{r.Kind}
	if r.Kind == "" {
		kinds = []string{"secret", "request"}
	}
	for i, k := range kinds {
		err = c.JSON(a.ctx, api.Call{Method: http.MethodDelete, Path: "/" + k + "s/" + r.ID, Auth: auth, Idempotent: true}, nil)
		var ae *api.Error
		if errors.As(err, &ae) && ae.Status == http.StatusNotFound && i < len(kinds)-1 {
			continue
		}
		if err != nil {
			return err
		}
		r.Kind = k
		break
	}
	status := "destroyed"
	if r.Kind == "request" {
		status = "cancelled"
	}
	if r.ManageToken != "" {
		a.finalize(r, status, nil)
		_ = a.store.DeleteKey(r.ID)
	}
	if a.json {
		a.printJSON(map[string]any{"id": r.ID, "kind": r.Kind, "destroyed": true})
		return nil
	}
	fmt.Fprintf(a.Stdout, "Destroyed %s %s.\n", r.Kind, r.ID)
	return nil
}

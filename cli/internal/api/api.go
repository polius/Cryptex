// Package api is a small HTTP client for the Cryptex 3 API (/api/v1).
package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Error is a JSON error from the API: {"error": {"code", "message", ...}}.
type Error struct {
	Status     int    `json:"-"`
	Code       string `json:"code"`
	Message    string `json:"message"`
	Field      string `json:"field,omitempty"`
	Limit      *int64 `json:"limit,omitempty"`
	TriesLeft  *int   `json:"tries_left,omitempty"`
	Reason     string `json:"reason,omitempty"`
	At         string `json:"at,omitempty"`
	ResetAt    string `json:"reset_at,omitempty"`
	RetryAfter int    `json:"-"`
}

func (e *Error) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	if e.Field != "" && e.Code != "not_found" {
		msg += " (" + e.Field + ")"
	}
	return msg
}

// NetError wraps a transport failure after retries.
type NetError struct{ Err error }

func (e *NetError) Error() string { return "network error: " + e.Err.Error() }
func (e *NetError) Unwrap() error { return e.Err }

// Client talks to one server.
type Client struct {
	Base      string // server origin, e.g. https://vault.acme.com (no /api/v1)
	Token     string // personal API token, sent only where Bearer is requested
	UserAgent string
	HTTP      *http.Client
	Attempts  int // total attempts for retryable calls (default 5)
	Backoff   func(attempt int) time.Duration
	Verbose   func(format string, a ...any)
}

// New returns a client with sensible timeouts.
func New(base, token, userAgent string) *Client {
	return &Client{
		Base:      strings.TrimRight(base, "/"),
		Token:     token,
		UserAgent: userAgent,
		HTTP: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 2 * time.Minute,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConnsPerHost:   4,
			ForceAttemptHTTP2:     true,
		}},
	}
}

// Auth values for the Authorization header.
const (
	AuthNone   = ""
	AuthBearer = "bearer" // use the client's API token if it has one
)

// Call describes one request.
type Call struct {
	Method string
	Path   string // under /api/v1, e.g. /secrets
	Auth   string // AuthNone, AuthBearer, or a full value such as "Reveal abc"
	Header map[string]string
	JSON   any    // request body encoded as JSON
	Body   []byte // raw octet-stream body (chunks)
	// Retry on any transport error or 502/503/504. Calls with side effects that aren't
	// idempotent (create, reveal) only retry when the connection never got established.
	Idempotent bool
	MaxBody    int64 // response body limit (default 1 MiB)
}

func (c *Client) attempts() int {
	if c.Attempts > 0 {
		return c.Attempts
	}
	return 5
}

func (c *Client) backoff(i int) time.Duration {
	if c.Backoff != nil {
		return c.Backoff(i)
	}
	d := time.Duration(400*(1<<i)) * time.Millisecond
	return d + time.Duration(rand.Int64N(int64(d/2)+1))
}

// dialFailed reports whether the request certainly never reached the server.
func dialFailed(err error) bool {
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		return true
	}
	var dns *net.DNSError
	return errors.As(err, &dns)
}

// Do runs a call and returns the raw response body for 2xx.
func (c *Client) Do(ctx context.Context, call Call) ([]byte, http.Header, error) {
	var lastErr error
	for i := 0; i < c.attempts(); i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			case <-time.After(c.backoff(i - 1)):
			}
		}
		body, hdr, err, retry := c.once(ctx, call)
		if err == nil {
			return body, hdr, nil
		}
		lastErr = err
		if !retry || ctx.Err() != nil {
			break
		}
		if c.Verbose != nil {
			c.Verbose("retrying %s %s: %v", call.Method, call.Path, err)
		}
	}
	return nil, nil, lastErr
}

func (c *Client) once(ctx context.Context, call Call) (body []byte, hdr http.Header, err error, retry bool) {
	var rd io.Reader
	ctype := ""
	switch {
	case call.JSON != nil:
		b, err := json.Marshal(call.JSON)
		if err != nil {
			return nil, nil, err, false
		}
		rd, ctype = bytes.NewReader(b), "application/json"
	case call.Body != nil:
		rd, ctype = bytes.NewReader(call.Body), "application/octet-stream"
	}
	req, err := http.NewRequestWithContext(ctx, call.Method, c.Base+"/api/v1"+call.Path, rd)
	if err != nil {
		return nil, nil, err, false
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	switch call.Auth {
	case AuthNone:
	case AuthBearer:
		if c.Token != "" {
			req.Header.Set("Authorization", "Bearer "+c.Token)
		}
	default:
		req.Header.Set("Authorization", call.Auth)
	}
	for k, v := range call.Header {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, nil, &NetError{Err: err}, call.Idempotent || dialFailed(err)
	}
	defer resp.Body.Close()
	limit := call.MaxBody
	if limit <= 0 {
		limit = 1 << 20
	}
	body, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, nil, &NetError{Err: err}, call.Idempotent
	}
	if int64(len(body)) > limit {
		return nil, nil, &NetError{Err: fmt.Errorf("response from %s larger than %d bytes", call.Path, limit)}, false
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return body, resp.Header, nil, false
	}
	e := &Error{Status: resp.StatusCode}
	var wrap struct {
		Error *Error `json:"error"`
	}
	if json.Unmarshal(body, &wrap) == nil && wrap.Error != nil {
		*e = *wrap.Error
		e.Status = resp.StatusCode
	} else {
		e.Code = "http_" + strconv.Itoa(resp.StatusCode)
		e.Message = fmt.Sprintf("the server answered %s", resp.Status)
	}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		e.RetryAfter, _ = strconv.Atoi(ra)
	}
	gateway := resp.StatusCode == 502 || resp.StatusCode == 503 || resp.StatusCode == 504
	return nil, resp.Header, e, gateway && call.Idempotent
}

// JSON runs a call and decodes a JSON response into out (if non-nil).
func (c *Client) JSON(ctx context.Context, call Call, out any) error {
	body, _, err := c.Do(ctx, call)
	if err != nil {
		return err
	}
	if out == nil || len(bytes.TrimSpace(body)) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &NetError{Err: fmt.Errorf("unexpected response from %s: %w", call.Path, err)}
	}
	return nil
}

// ---------------------------------------------------------------- server-sent events

// Event is one SSE message.
type Event struct {
	ID    string
	Event string
	Data  string
}

// Events streams SSE messages from path until ctx ends or the server closes the stream.
func (c *Client) Events(ctx context.Context, path, lastID string, fn func(Event) error) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/api/v1"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	hc := *c.HTTP
	hc.Timeout = 0
	resp, err := hc.Do(req)
	if err != nil {
		return &NetError{Err: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		e := &Error{Status: resp.StatusCode, Code: "http_" + strconv.Itoa(resp.StatusCode), Message: resp.Status}
		var wrap struct {
			Error *Error `json:"error"`
		}
		if json.Unmarshal(body, &wrap) == nil && wrap.Error != nil {
			*e = *wrap.Error
			e.Status = resp.StatusCode
		}
		return e
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	var ev Event
	var data []string
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if len(data) > 0 || ev.Event != "" {
				ev.Data = strings.Join(data, "\n")
				if err := fn(ev); err != nil {
					return err
				}
			}
			ev, data = Event{ID: ev.ID}, nil
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		k, v, _ := strings.Cut(line, ":")
		v = strings.TrimPrefix(v, " ")
		switch k {
		case "event":
			ev.Event = v
		case "data":
			data = append(data, v)
		case "id":
			ev.ID = v
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return &NetError{Err: err}
	}
	return ctx.Err()
}

// ---------------------------------------------------------------- demo proof of work

// LeadingZeroBits counts leading zero bits of a digest.
func LeadingZeroBits(d []byte) int {
	n := 0
	for _, b := range d {
		if b == 0 {
			n += 8
			continue
		}
		for m := byte(0x80); m != 0 && b&m == 0; m >>= 1 {
			n++
		}
		break
	}
	return n
}

// SolvePoW finds a decimal nonce so SHA-256(challenge + ":" + nonce) has at least bits
// leading zero bits, and returns the X-PoW header value "challenge:nonce".
func SolvePoW(ctx context.Context, challenge string, bits int) (string, error) {
	buf := []byte(challenge + ":")
	base := len(buf)
	for n := uint64(0); ; n++ {
		if n&0xffff == 0 && ctx.Err() != nil {
			return "", ctx.Err()
		}
		buf = strconv.AppendUint(buf[:base], n, 10)
		sum := sha256.Sum256(buf)
		if LeadingZeroBits(sum[:]) >= bits {
			return string(buf), nil
		}
	}
}

// PoW fetches a challenge and solves it.
func (c *Client) PoW(ctx context.Context) (string, error) {
	var ch struct {
		Challenge string `json:"challenge"`
		Bits      int    `json:"bits"`
	}
	if err := c.JSON(ctx, Call{Method: http.MethodGet, Path: "/demo/challenge", Idempotent: true}, &ch); err != nil {
		return "", err
	}
	return SolvePoW(ctx, ch.Challenge, ch.Bits)
}

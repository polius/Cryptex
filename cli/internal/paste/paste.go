// Package paste ports the composer's paste parser (design/v3/spec/frontend.md §5).
//
// The first rule that matches the whole paste wins; otherwise the paste stays a note.
package paste

import (
	"regexp"
	"strings"
)

// Rule numbers from frontend.md §5.
const (
	RulePEM   = 1
	RuleEnv   = 2
	RuleColon = 3
	RuleURL   = 4
	RuleLogin = 5
	RuleNote  = 6
)

// Field is one parsed key/value pair.
type Field struct {
	Key    string `json:"k"`
	Value  string `json:"v"`
	Secret bool   `json:"secret"`
}

// Result is what the parser made of a paste.
type Result struct {
	Rule   int     // which rule matched
	Kind   string  // pem, env, colon, url, login, note
	Fields []Field // empty for a note
	Note   string  // the raw text (line endings as given) when Rule == RuleNote
}

var (
	secretKey = regexp.MustCompile(`(?i)pass|secret|token|key|pwd|private|credential`)
	pemBlock  = regexp.MustCompile(`^-----BEGIN ([A-Z0-9 ]+)-----\n(?:[^\n]*\n)*?-----END ([A-Z0-9 ]+)-----$`)
	envLine   = regexp.MustCompile(`^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.\-]*)[ \t]*=(.*)$`)
	colonLine = regexp.MustCompile(`^([^:\s][^:]{0,63}?)[ \t]*:(?:[ \t]+(.*))?$`)
	credURL   = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9+.\-]*)://([^:/@\s]+):([^@\s]*)@(\S+)$`)
	identity  = regexp.MustCompile(`^[^\s]{1,254}$`)
	secretVal = regexp.MustCompile(`^\S+$`)
)

// IsSecretKey reports whether a field name looks like it holds a secret.
func IsSecretKey(k string) bool { return secretKey.MatchString(k) }

func field(k, v string) Field { return Field{Key: k, Value: v, Secret: IsSecretKey(k)} }

// lines normalizes CRLF/CR line endings and trims trailing whitespace on every line.
func lines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	ls := strings.Split(text, "\n")
	for i, l := range ls {
		ls[i] = strings.TrimRight(l, " \t")
	}
	return ls
}

func nonEmpty(ls []string) []string {
	out := make([]string, 0, len(ls))
	for _, l := range ls {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

func unquote(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
		inner := v[1 : len(v)-1]
		if v[0] == '"' {
			inner = strings.NewReplacer(`\n`, "\n", `\"`, `"`, `\\`, `\`).Replace(inner)
		}
		return inner
	}
	return v
}

// Parse applies the rules in order to the whole paste.
func Parse(text string) Result {
	ls := lines(text)
	body := nonEmpty(ls)
	note := Result{Rule: RuleNote, Kind: "note", Note: text}
	if len(body) == 0 {
		return note
	}
	joined := strings.TrimSpace(strings.Join(ls, "\n"))

	// 1. One PEM block.
	if m := pemBlock.FindStringSubmatch(joined); m != nil && m[1] == m[2] && strings.Count(joined, "-----BEGIN ") == 1 {
		return Result{Rule: RulePEM, Kind: "pem", Fields: []Field{{Key: "Private key", Value: joined, Secret: true}}}
	}

	// 2. Every non-empty, non-# line is KEY=value.
	if fs := parseEnv(body); fs != nil {
		return Result{Rule: RuleEnv, Kind: "env", Fields: fs}
	}

	// 3. Every line is `key: value` (2+ lines).
	if len(body) >= 2 {
		fs := make([]Field, 0, len(body))
		for _, l := range body {
			m := colonLine.FindStringSubmatch(strings.TrimSpace(l))
			if m == nil {
				fs = nil
				break
			}
			fs = append(fs, field(strings.TrimSpace(m[1]), strings.TrimSpace(m[2])))
		}
		if fs != nil {
			return Result{Rule: RuleColon, Kind: "colon", Fields: fs}
		}
	}

	// 4. One URL with credentials.
	if len(body) == 1 {
		if m := credURL.FindStringSubmatch(strings.TrimSpace(body[0])); m != nil {
			return Result{Rule: RuleURL, Kind: "url", Fields: []Field{
				{Key: "Host", Value: m[4]},
				{Key: "Username", Value: m[2]},
				{Key: "Password", Value: m[3], Secret: true},
				{Key: "Type", Value: m[1]},
			}}
		}
	}

	// 5. Two lines: identity, then secret.
	if len(body) == 2 {
		id, sec := strings.TrimSpace(body[0]), strings.TrimSpace(body[1])
		if identity.MatchString(id) && secretVal.MatchString(sec) && !strings.Contains(id, "://") {
			return Result{Rule: RuleLogin, Kind: "login", Fields: []Field{
				{Key: "Username", Value: id},
				{Key: "Password", Value: sec, Secret: true},
			}}
		}
	}

	// 6. Anything else.
	return note
}

func parseEnv(body []string) []Field {
	var fs []Field
	for _, l := range body {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "#") {
			continue
		}
		m := envLine.FindStringSubmatch(t)
		if m == nil {
			return nil
		}
		fs = append(fs, field(m[1], unquote(m[2])))
	}
	return fs
}

package paste

import (
	"reflect"
	"testing"
)

func TestParse(t *testing.T) {
	pem := "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAAAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIA==\n-----END OPENSSH PRIVATE KEY-----"
	f := func(k, v string, secret bool) Field { return Field{Key: k, Value: v, Secret: secret} }
	tests := []struct {
		name   string
		in     string
		rule   int
		fields []Field
	}{
		// Row 1: one PEM block.
		{"pem", pem, RulePEM, []Field{f("Private key", pem, true)}},
		{"pem with trailing newline and spaces", pem + "  \n\n", RulePEM, []Field{f("Private key", pem, true)}},
		{"pem with CRLF", "-----BEGIN RSA PRIVATE KEY-----\r\nMIIB\r\n-----END RSA PRIVATE KEY-----\r\n", RulePEM,
			[]Field{f("Private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", true)}},
		{"two pem blocks are a note", pem + "\n" + pem, RuleNote, nil},
		{"pem with text before is a note", "my key:\n" + pem, RuleNote, nil},
		{"pem with mismatched END is a note", "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END EC PRIVATE KEY-----", RuleNote, nil},

		// Row 2: .env.
		{"env", "DB_HOST=db\nDB_PASSWORD=\"x y\"", RuleEnv, []Field{f("DB_HOST", "db", false), f("DB_PASSWORD", "x y", true)}},
		{"env single quotes, comments, blank lines, export", "# staging\n\nexport API_TOKEN='abc def'\nPORT=5432\n", RuleEnv,
			[]Field{f("API_TOKEN", "abc def", true), f("PORT", "5432", false)}},
		{"env single line", "SECRET_KEY=k7#Qp2", RuleEnv, []Field{f("SECRET_KEY", "k7#Qp2", true)}},
		{"env value with = and spaces around", "URL=postgres://a:b@h/x?ssl=true\nNAME = value ", RuleEnv,
			[]Field{f("URL", "postgres://a:b@h/x?ssl=true", false), f("NAME", "value", false)}},
		{"env windows line endings", "A=1\r\nB_PWD=2\r\n", RuleEnv, []Field{f("A", "1", false), f("B_PWD", "2", true)}},
		{"env trailing spaces", "A=1   \nB=2\t\n", RuleEnv, []Field{f("A", "1", false), f("B", "2", false)}},
		{"env empty values", "A=\nB=\"\"\nC=3", RuleEnv, []Field{f("A", "", false), f("B", "", false), f("C", "3", false)}},
		{"env duplicate keys kept in order", "A=1\nB=2\nA=3", RuleEnv, []Field{f("A", "1", false), f("B", "2", false), f("A", "3", false)}},
		{"env with a non-env line is a note", "A=1\nhello world", RuleNote, nil},
		{"only comments is a note", "# nothing\n# here", RuleNote, nil},

		// Row 3: key: value (2+ lines).
		{"colon", "host: db\npassword: hunter2", RuleColon, []Field{f("host", "db", false), f("password", "hunter2", true)}},
		{"colon values with colons", "url: https://x.example:8443/a\ntime: 12:30", RuleColon,
			[]Field{f("url", "https://x.example:8443/a", false), f("time", "12:30", false)}},
		{"colon keys with spaces", "Access key ID: AKIA\nSecret access key: wJal/K7", RuleColon,
			[]Field{f("Access key ID", "AKIA", true), f("Secret access key", "wJal/K7", true)}},
		{"colon windows line endings and trailing spaces", "host: db  \r\nuser: sam \r\n", RuleColon,
			[]Field{f("host", "db", false), f("user", "sam", false)}},
		{"colon empty value", "host: db\ntoken:\nnote: x", RuleColon,
			[]Field{f("host", "db", false), f("token", "", true), f("note", "x", false)}},
		{"colon duplicate keys kept in order", "a: 1\nb: 2\na: 3", RuleColon, []Field{f("a", "1", false), f("b", "2", false), f("a", "3", false)}},
		{"colon single line is not rule 3", "host: db", RuleNote, nil},
		{"colon with free text line is a note", "host: db\nand some text", RuleNote, nil},

		// Row 4: one URL with credentials.
		{"url", "postgres://app:pw@db:5432/x", RuleURL,
			[]Field{f("Host", "db:5432/x", false), f("Username", "app", false), f("Password", "pw", true), f("Type", "postgres", false)}},
		{"url with surrounding whitespace and CRLF", "  redis://default:s3cr3t@cache.internal:6379\r\n", RuleURL,
			[]Field{f("Host", "cache.internal:6379", false), f("Username", "default", false), f("Password", "s3cr3t", true), f("Type", "redis", false)}},
		{"url empty password", "ftp://anon:@files.example", RuleURL,
			[]Field{f("Host", "files.example", false), f("Username", "anon", false), f("Password", "", true), f("Type", "ftp", false)}},
		{"url without credentials is a note", "https://example.com/path", RuleNote, nil},

		// Row 5: two lines, identity then secret.
		{"login", "sam@acme.example\nk7#Qp2-vR9mL", RuleLogin, []Field{f("Username", "sam@acme.example", false), f("Password", "k7#Qp2-vR9mL", true)}},
		{"login windows line endings and trailing spaces", "sam  \r\nhunter2 \r\n", RuleLogin,
			[]Field{f("Username", "sam", false), f("Password", "hunter2", true)}},
		{"two lines with spaces are a note", "Hi Sam,\nthe password is below", RuleNote, nil},
		{"three lines is a note", "a\nb\nc", RuleNote, nil},

		// Row 6: anything else.
		{"free text", "Just call me when you get this.", RuleNote, nil},
		{"empty", "", RuleNote, nil},
		{"whitespace only", " \r\n\t\n", RuleNote, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Parse(tc.in)
			if got.Rule != tc.rule {
				t.Fatalf("rule %d (%s), want %d; fields %+v", got.Rule, got.Kind, tc.rule, got.Fields)
			}
			if tc.rule == RuleNote {
				if got.Note != tc.in || len(got.Fields) != 0 {
					t.Fatalf("note should keep the raw text: %q", got.Note)
				}
				return
			}
			if !reflect.DeepEqual(got.Fields, tc.fields) {
				t.Fatalf("fields\n got %+v\nwant %+v", got.Fields, tc.fields)
			}
		})
	}
}

func TestIsSecretKey(t *testing.T) {
	for k, want := range map[string]bool{
		"password": true, "DB_PASS": true, "client_secret": true, "API_TOKEN": true, "ssh key": true, "PWD": true,
		"private": true, "Credentials": true, "host": false, "user": false, "port": false,
	} {
		if IsSecretKey(k) != want {
			t.Errorf("IsSecretKey(%q) = %v", k, !want)
		}
	}
}

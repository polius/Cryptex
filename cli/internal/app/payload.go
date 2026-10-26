package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/polius/cryptex/cli/internal/api"
	"github.com/polius/cryptex/cli/internal/crypto"
	"github.com/polius/cryptex/cli/internal/paste"
)

// Item is one manifest entry (crypto-v1.md §3.4).
type Item struct {
	T      string `json:"t"`
	K      string `json:"k,omitempty"`
	V      string `json:"v,omitempty"`
	Secret bool   `json:"secret,omitempty"`
	Name   string `json:"name,omitempty"`
	Type   string `json:"type,omitempty"`
	Size   int64  `json:"size,omitempty"`
	Stream int    `json:"stream,omitempty"`
}

// MarshalJSON writes exactly the keys the format defines for each item type.
func (it Item) MarshalJSON() ([]byte, error) {
	switch it.T {
	case "note":
		return marshal(struct {
			T string `json:"t"`
			V string `json:"v"`
		}{it.T, it.V})
	case "field":
		return marshal(struct {
			T      string `json:"t"`
			K      string `json:"k"`
			V      string `json:"v"`
			Secret bool   `json:"secret"`
		}{it.T, it.K, it.V, it.Secret})
	case "file":
		return marshal(struct {
			T      string `json:"t"`
			Name   string `json:"name"`
			Type   string `json:"type"`
			Size   int64  `json:"size"`
			Stream int    `json:"stream"`
		}{it.T, it.Name, it.Type, it.Size, it.Stream})
	}
	return nil, fmt.Errorf("unknown item type %q", it.T)
}

func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// Manifest is stream 0.
type Manifest struct {
	V     int    `json:"v"`
	Items []Item `json:"items"`
}

// source is one plaintext stream to upload.
type source struct {
	stream int
	prefix []byte
	size   int64
	data   []byte // in-memory stream (the manifest)
	path   string // or a file on disk
	name   string // for progress
}

func (s source) desc() map[string]any {
	return map[string]any{"stream": s.stream, "prefix": crypto.B64u(s.prefix), "chunks": crypto.ChunkCount(s.size),
		"size": crypto.CiphertextSize(s.size)}
}

// content is what a send or an answer carries.
type content struct {
	items   []Item
	sources []source
	chars   int
}

// textItems turns text into a note, or into fields with the paste parser.
func textItems(text string, parseFields bool) ([]Item, bool) {
	if parseFields {
		r := paste.Parse(text)
		if r.Rule != paste.RuleNote {
			out := make([]Item, 0, len(r.Fields))
			for _, f := range r.Fields {
				out = append(out, Item{T: "field", K: f.Key, V: f.Value, Secret: f.Secret})
			}
			return out, true
		}
	}
	return []Item{{T: "note", V: text}}, false
}

func countChars(items []Item) int {
	n := 0
	for _, it := range items {
		n += utf8.RuneCountInString(it.V) + utf8.RuneCountInString(it.K)
	}
	return n
}

// buildContent stats files and assembles the manifest. Text items come first.
func buildContent(text []Item, files []string, maxFiles int, maxFileBytes int64, maxChars int) (*content, error) {
	c := &content{items: append([]Item{}, text...)}
	c.chars = countChars(text)
	if maxChars > 0 && c.chars > maxChars {
		return nil, usagef("the message is %d characters; this server allows %d. Send long text as a file", c.chars, maxChars)
	}
	if len(files) > maxFiles {
		return nil, usagef("%d files; this server allows %d", len(files), maxFiles)
	}
	for i, p := range files {
		fi, err := os.Stat(p)
		if err != nil {
			return nil, usagef("%v", err)
		}
		if !fi.Mode().IsRegular() {
			return nil, usagef("%s isn't a regular file", p)
		}
		if maxFileBytes > 0 && fi.Size() > maxFileBytes {
			return nil, usagef("%s is %s; this server allows %s per file", p, humanBytes(fi.Size()), humanBytes(maxFileBytes))
		}
		name := filepath.Base(p)
		typ := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
		if typ == "" {
			typ = "application/octet-stream"
		}
		if mt, _, err := mime.ParseMediaType(typ); err == nil {
			typ = mt
		}
		c.items = append(c.items, Item{T: "file", Name: name, Type: typ, Size: fi.Size(), Stream: i + 1})
		c.sources = append(c.sources, source{stream: i + 1, prefix: crypto.Random(crypto.PrefixSize), size: fi.Size(), path: p, name: name})
	}
	if len(c.items) == 0 {
		return nil, usagef("nothing to send: pipe text on stdin or name files")
	}
	m, err := json.Marshal(Manifest{V: 1, Items: c.items})
	if err != nil {
		return nil, err
	}
	c.sources = append([]source{{stream: 0, prefix: crypto.Random(crypto.PrefixSize), size: int64(len(m)), data: m}}, c.sources...)
	return c, nil
}

func (c *content) descs() []map[string]any {
	out := make([]map[string]any, len(c.sources))
	for i, s := range c.sources {
		out[i] = s.desc()
	}
	return out
}

func (c *content) files() int { return len(c.sources) - 1 }

// uploader PUTs encrypted chunks.
type uploader struct {
	a      *App
	client *api.Client
	path   string // e.g. /secrets/ID/chunks
	auth   string // "Upload …"
	key    []byte
	id     string // bound in the AAD
}

// upload encrypts and sends every stream, one chunk at a time (two chunk buffers in memory).
func (u *uploader) upload(srcs []source) error {
	buf := make([]byte, crypto.ChunkSize)
	ct := make([]byte, 0, crypto.MaxChunkCiphertext)
	for _, s := range srcs {
		if err := u.uploadStream(s, buf, ct); err != nil {
			return err
		}
	}
	return nil
}

func (u *uploader) uploadStream(s source, buf, ct []byte) error {
	var r io.Reader
	if s.path != "" {
		f, err := os.Open(s.path)
		if err != nil {
			return usagef("%v", err)
		}
		defer f.Close()
		r = f
	} else {
		r = bytes.NewReader(s.data)
	}
	st := crypto.NewStream(u.key, u.id, uint32(s.stream), s.prefix)
	chunks := crypto.ChunkCount(s.size)
	left := s.size
	progress := chunks > 1 && isTerminal(u.a.Stderr) && !u.a.json
	for i := int64(0); i < chunks; i++ {
		n := min(left, crypto.ChunkSize)
		if _, err := io.ReadFull(r, buf[:n]); err != nil {
			return failf("reading %s: %v (did the file change while uploading?)", s.name, err)
		}
		left -= n
		last := i == chunks-1
		if last {
			var one [1]byte
			if m, _ := r.Read(one[:]); m > 0 {
				return failf("%s grew while uploading; try again", s.name)
			}
		}
		ct = st.Seal(ct[:0], uint32(i), last, buf[:n])
		call := api.Call{Method: http.MethodPut, Path: fmt.Sprintf("%s/%d/%d", u.path, s.stream, i), Auth: u.auth, Body: ct, Idempotent: true}
		if _, _, err := u.client.Do(u.a.ctx, call); err != nil {
			return err
		}
		if progress {
			fmt.Fprintf(u.a.Stderr, "\rUploading %s: %d%%", s.name, (i+1)*100/chunks)
		}
	}
	if progress {
		fmt.Fprintln(u.a.Stderr)
	}
	return nil
}

// StreamDesc is one stream as the server lists it.
type StreamDesc struct {
	Stream int    `json:"stream"`
	Prefix string `json:"prefix"`
	Chunks int64  `json:"chunks"`
	Size   int64  `json:"size"`
}

// downloader GETs and decrypts chunks.
type downloader struct {
	a      *App
	client *api.Client
	path   string // e.g. /secrets/ID/chunks
	auth   string
	key    []byte
	id     string
}

func (d *downloader) stream(desc StreamDesc, w io.Writer, label string) error {
	prefix, err := crypto.UnB64u(desc.Prefix)
	if err != nil || len(prefix) != crypto.PrefixSize || desc.Chunks < 1 {
		return failf("the server sent a malformed stream descriptor")
	}
	st := crypto.NewStream(d.key, d.id, uint32(desc.Stream), prefix)
	var out []byte
	var total int64
	progress := desc.Chunks > 1 && isTerminal(d.a.Stderr) && !d.a.json
	for i := int64(0); i < desc.Chunks; i++ {
		call := api.Call{Method: http.MethodGet, Path: fmt.Sprintf("%s/%d/%d", d.path, desc.Stream, i), Auth: d.auth,
			Idempotent: true, MaxBody: crypto.MaxChunkCiphertext}
		ct, _, err := d.client.Do(d.a.ctx, call)
		if err != nil {
			return err
		}
		out, err = st.Open(out[:0], uint32(i), i == desc.Chunks-1, ct)
		if err != nil {
			return err
		}
		total += int64(len(ct))
		if _, err := w.Write(out); err != nil {
			return err
		}
		if progress {
			fmt.Fprintf(d.a.Stderr, "\rDownloading %s: %d%%", label, (i+1)*100/desc.Chunks)
		}
	}
	if progress {
		fmt.Fprintln(d.a.Stderr)
	}
	if total != desc.Size {
		return failf("stream %d is %d bytes, the server said %d", desc.Stream, total, desc.Size)
	}
	return nil
}

// payload downloads the manifest and every file it lists. Files are written to outDir.
func (d *downloader) payload(streams []StreamDesc, outDir string) ([]OutItem, error) {
	byIdx := map[int]StreamDesc{}
	for _, s := range streams {
		byIdx[s.Stream] = s
	}
	s0, ok := byIdx[0]
	if !ok || s0.Size > 16<<20 {
		return nil, failf("the server sent no manifest stream")
	}
	var mb bytes.Buffer
	if err := d.stream(s0, &mb, "manifest"); err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(mb.Bytes(), &m); err != nil || m.V != 1 {
		return nil, failf("unreadable manifest (version %d): %v", m.V, err)
	}
	var out []OutItem
	saved := map[string]bool{}
	for _, it := range m.Items {
		o := OutItem{T: it.T, K: it.K, V: it.V, Secret: it.Secret, Name: it.Name, Type: it.Type, Size: it.Size}
		if it.T == "file" {
			desc, ok := byIdx[it.Stream]
			if !ok || it.Stream == 0 {
				return out, failf("file %q points to a missing stream", it.Name)
			}
			path, err := d.saveFile(desc, it, outDir, saved)
			if err != nil {
				return out, err
			}
			o.Path = path
		}
		out = append(out, o)
	}
	return out, nil
}

func (d *downloader) saveFile(desc StreamDesc, it Item, outDir string, saved map[string]bool) (string, error) {
	tmp, err := os.CreateTemp(outDir, ".cryptex-*.part")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err := d.stream(desc, tmp, it.Name); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	dst := uniquePath(outDir, SafeName(it.Name, it.Stream), saved)
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return "", err
	}
	_ = os.Chmod(dst, 0o600)
	saved[dst] = true
	return dst, nil
}

// SafeName strips directories and characters that aren't safe in a file name.
func SafeName(name string, stream int) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = filepath.Base("/" + name)
	if name == "/" || name == string(filepath.Separator) || name == "." {
		name = ""
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`<>:"/\|?*`, r) && runtime.GOOS == "windows" || r == '/' {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimLeft(strings.TrimSpace(name), ".")
	if name == "" {
		name = fmt.Sprintf("file-%d", stream)
	}
	if len(name) > 200 {
		ext := filepath.Ext(name)
		if len(ext) > 20 {
			ext = ""
		}
		name = name[:200-len(ext)] + ext
	}
	return name
}

func uniquePath(dir, name string, taken map[string]bool) string {
	p := filepath.Join(dir, name)
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		if _, err := os.Lstat(p); errors.Is(err, os.ErrNotExist) && !taken[p] {
			return p
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
	}
}

// ensureOutDir creates and checks the output directory before anything irreversible happens.
func ensureOutDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return usagef("can't create %s: %v", dir, err)
	}
	f, err := os.CreateTemp(dir, ".cryptex-check-*")
	if err != nil {
		return usagef("can't write to %s: %v", dir, err)
	}
	f.Close()
	os.Remove(f.Name())
	return nil
}

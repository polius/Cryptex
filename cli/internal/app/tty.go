package app

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"golang.org/x/term"
)

var errNoTTY = errors.New("no terminal to prompt on")

func noPrompt() bool {
	v := strings.ToLower(os.Getenv("CRYPTEX_NO_PROMPT"))
	return v != "" && v != "0" && v != "false"
}

func isTerminal(f any) bool {
	if file, ok := f.(*os.File); ok {
		return term.IsTerminal(int(file.Fd()))
	}
	return false
}

// stdinIsTTY reports whether stdin is an interactive terminal.
func (a *App) stdinIsTTY() bool { return isTerminal(a.Stdin) }

// openTTY opens the controlling terminal even when stdin is redirected.
func openTTY() (*os.File, error) {
	if noPrompt() {
		return nil, errNoTTY
	}
	name := "/dev/tty"
	if runtime.GOOS == "windows" {
		name = "CONIN$"
	}
	f, err := os.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		return nil, errNoTTY
	}
	if !term.IsTerminal(int(f.Fd())) {
		f.Close()
		return nil, errNoTTY
	}
	return f, nil
}

// canPrompt reports whether there is a terminal to ask questions on.
func canPrompt() bool {
	f, err := openTTY()
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// promptSecret reads a line without echo from the terminal.
func (a *App) promptSecret(prompt string) (string, error) {
	f, err := openTTY()
	if err != nil {
		return "", err
	}
	defer f.Close()
	fmt.Fprint(a.Stderr, prompt)
	b, err := term.ReadPassword(int(f.Fd()))
	fmt.Fprintln(a.Stderr)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// promptLine reads a visible line from the terminal.
func (a *App) promptLine(prompt string) (string, error) {
	f, err := openTTY()
	if err != nil {
		return "", err
	}
	defer f.Close()
	fmt.Fprint(a.Stderr, prompt)
	line, err := bufio.NewReader(f).ReadString('\n')
	if err != nil && !(errors.Is(err, io.EOF) && line != "") {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// openBrowser tries to open a URL; failures are silent (the URL is printed anyway).
func openBrowser(u string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if cmd.Start() == nil {
		go func() { _ = cmd.Wait() }()
	}
}

// copyToClipboard uses the platform's clipboard tool.
func copyToClipboard(text string) error {
	var candidates [][]string
	switch runtime.GOOS {
	case "darwin":
		candidates = [][]string{{"pbcopy"}}
	case "windows":
		candidates = [][]string{{"clip.exe"}, {"clip"}}
	default:
		candidates = [][]string{{"wl-copy"}, {"xclip", "-selection", "clipboard"}, {"xsel", "--clipboard", "--input"}}
	}
	for _, c := range candidates {
		if _, err := exec.LookPath(c[0]); err != nil {
			continue
		}
		cmd := exec.Command(c[0], c[1:]...)
		cmd.Stdin = strings.NewReader(text)
		if err := cmd.Run(); err == nil {
			return nil
		}
	}
	return errors.New("no clipboard tool found (pbcopy, wl-copy, xclip, xsel or clip)")
}

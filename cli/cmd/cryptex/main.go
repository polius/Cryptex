// Command cryptex is the command-line client for Cryptex 3.
package main

import (
	"os"

	"github.com/polius/cryptex/cli/internal/app"
)

func main() { os.Exit(app.Main(os.Args[1:])) }

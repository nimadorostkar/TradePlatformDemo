// Command wsprobe connects to a /ws URL and prints either "HTTP <code>" when
// the upgrade is rejected, or the first -n frames (one per line). Exit 0 on
// frames received, 1 on rejection/timeout. Used by the end-to-end test script.
//
// Authentication:
//
//	-token <jwt>   authenticate with the `tradeplatform.jwt.<JWT>` subprotocol.
//	               This is the production transport and the only one that works
//	               against the default configuration.
//	?access_token= in the URL is the legacy query-string transport, accepted by
//	               the server only when WS_ALLOW_QUERY_TOKEN=true. Probing it is
//	               how the end-to-end suite proves it stays rejected by default.
//
// The subprotocol carries the credential in a header rather than in the URL,
// because query strings are routinely retained by proxies and access logs.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/coder/websocket"
)

const (
	wsApplicationProtocol = "tradeplatform.v1"
	wsJWTProtocolPrefix   = "tradeplatform.jwt."
)

func main() {
	n := flag.Int("n", 1, "frames to read")
	timeout := flag.Duration("timeout", 10*time.Second, "overall timeout")
	token := flag.String("token", "", "JWT presented via the tradeplatform.jwt.<JWT> subprotocol")
	printProto := flag.Bool("print-subprotocol", false, "print the negotiated subprotocol before any frame")
	flag.Parse()
	url := flag.Arg(0)
	if url == "" {
		fmt.Fprintln(os.Stderr, "usage: wsprobe [-n frames] [-token JWT] <ws-url>")
		os.Exit(2)
	}

	var opts *websocket.DialOptions
	if *token != "" {
		// The server negotiates only tradeplatform.v1, so the secret never appears in
		// the response — offer it alongside the application protocol.
		opts = &websocket.DialOptions{
			Subprotocols: []string{wsJWTProtocolPrefix + *token, wsApplicationProtocol},
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		if resp != nil {
			fmt.Printf("HTTP %d\n", resp.StatusCode)
		} else {
			fmt.Printf("DIAL ERROR: %v\n", err)
		}
		os.Exit(1)
	}
	defer conn.CloseNow()
	if *printProto {
		fmt.Printf("SUBPROTOCOL %s\n", conn.Subprotocol())
	}
	for i := 0; i < *n; i++ {
		_, data, err := conn.Read(ctx)
		if err != nil {
			fmt.Printf("READ ERROR: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(string(data))
	}
}

// hatch-tailscale owns one private tsnet node. Its only control channel is the
// parent's stdin; stdout carries bounded status snapshots, never credentials.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

type snapshot struct {
	State    string `json:"state"`
	LoginURL string `json:"loginUrl"`
	Origin   string `json:"origin"`
	Message  string `json:"message"`
}

func main() {
	hostname := flag.String("hostname", "hatch", "Tailnet node name")
	dir := flag.String("state-dir", "", "Private persistent state directory")
	port := flag.Int("port", 3700, "Platform loopback HTTP port")
	flag.Parse()
	if *dir == "" || *port < 1 || *port > 65535 {
		log.Fatal("invalid state directory or platform port")
	}
	if err := os.MkdirAll(*dir, 0700); err != nil {
		log.Fatal("cannot create private state directory")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// EOF also shuts down on abrupt parent death, including SIGKILL.
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	s := &tsnet.Server{
		Hostname: *hostname, Dir: *dir,
		Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {},
	}
	defer s.Close()
	encoder := json.NewEncoder(os.Stdout)
	emit := func(v snapshot) {
		if encoder.Encode(v) != nil {
			cancel()
		}
	}
	if err := s.Start(); err != nil {
		emit(snapshot{State: "error", Message: "Unable to start Tailscale. Check the private state directory."})
		return
	}
	lc, err := s.LocalClient()
	if err != nil {
		return
	}
	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", *port))
	httpServer := &http.Server{Handler: proxy(target), ReadHeaderTimeout: 15 * time.Second}
	defer httpServer.Close()
	var listening bool
	serveErrors := make(chan error, 1)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		pollCtx, pollCancel := context.WithTimeout(ctx, 15*time.Second)
		st, err := lc.StatusWithoutPeers(pollCtx)
		v := snapshot{State: "starting"}
		if err != nil {
			v = snapshot{State: "error", Message: "Cannot read Tailscale status. Retrying automatically."}
		} else {
			switch st.BackendState {
			case "NeedsLogin":
				v.State, v.LoginURL = "needs-login", st.AuthURL
			case "NeedsMachineAuth":
				v.State = "needs-approval"
			case "Running":
				if st.CurrentTailnet == nil || !st.CurrentTailnet.MagicDNSEnabled || len(st.CertDomains) == 0 {
					v = snapshot{State: "error", Message: "Enable MagicDNS and HTTPS certificates in your Tailscale DNS settings. This page will retry automatically."}
				} else {
					domain := st.CertDomains[0]
					if !listening {
						_, _, err = lc.CertPair(pollCtx, domain)
						if err == nil {
							ln, listenErr := s.ListenTLS("tcp", ":443")
							err = listenErr
							if err == nil {
								listening = true
								go func() { serveErrors <- httpServer.Serve(ln) }()
							}
						}
					}
					if err != nil {
						v = snapshot{State: "error", Message: "HTTPS is not ready. Check Tailscale certificate settings and network connectivity. Retrying automatically."}
					} else {
						v = snapshot{State: "connected", Origin: "https://" + domain}
					}
				}
			}
		}
		pollCancel()
		emit(v)
		select {
		case <-ctx.Done():
			return
		case <-serveErrors:
			emit(snapshot{State: "error", Message: "The Tailscale HTTPS listener stopped. Reconnect to try again."})
			return
		case <-ticker.C:
		}
	}
}

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

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

type dnsStatus struct {
	MagicDNSEnabled          *bool `json:"magicDnsEnabled"`
	HTTPSCertificatesEnabled *bool `json:"httpsCertificatesEnabled"`
}

type snapshot struct {
	State    string       `json:"state"`
	LoginURL string       `json:"loginUrl"`
	Origin   string       `json:"origin"`
	Message  string       `json:"message"`
	DNS      *dnsStatus   `json:"dns,omitempty"`
	HTTPS    *httpsStatus `json:"https,omitempty"`
}

// Keep unknown tailnet data distinct from a setting reported as disabled.
func connectionDNS(st *ipnstate.Status) (*dnsStatus, string) {
	dns := &dnsStatus{}
	if st.CurrentTailnet != nil {
		dns.MagicDNSEnabled = &st.CurrentTailnet.MagicDNSEnabled
		httpsEnabled := len(st.CertDomains) > 0
		dns.HTTPSCertificatesEnabled = &httpsEnabled
	} else if len(st.CertDomains) > 0 {
		httpsEnabled := true
		dns.HTTPSCertificatesEnabled = &httpsEnabled
	}
	if dns.MagicDNSEnabled == nil {
		return dns, "Cannot read the MagicDNS setting from Tailscale yet. Retrying automatically."
	}
	if !*dns.MagicDNSEnabled && !*dns.HTTPSCertificatesEnabled {
		return dns, "Enable MagicDNS and HTTPS certificates in your Tailscale DNS settings. Hatch will detect the change and continue connecting automatically."
	}
	if !*dns.MagicDNSEnabled {
		return dns, "Enable MagicDNS in your Tailscale DNS settings. Hatch will detect the change and continue connecting automatically."
	}
	if !*dns.HTTPSCertificatesEnabled {
		return dns, "Enable HTTPS certificates in your Tailscale DNS settings. Hatch will detect the change and continue connecting automatically."
	}
	return dns, ""
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
	serveErrors := make(chan error, 1)
	https := httpsPreparation{
		certificate: func(ctx context.Context, domain string) error {
			_, _, err := lc.CertPair(ctx, domain)
			return err
		},
		listen: func() error {
			ln, err := s.ListenTLS("tcp", ":443")
			if err == nil {
				go func() { serveErrors <- httpServer.Serve(ln) }()
			}
			return err
		},
		emit: emit,
		now:  time.Now,
	}
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
				https.startedAt = time.Time{}
				v.State, v.LoginURL = "needs-login", st.AuthURL
			case "NeedsMachineAuth":
				https.startedAt = time.Time{}
				v.State = "needs-approval"
			case "Running":
				dns, message := connectionDNS(st)
				if message != "" {
					https.startedAt = time.Time{}
					v = snapshot{State: "error", DNS: dns, Message: message}
				} else {
					https.dns = dns
					v = https.prepare(pollCtx, st.CertDomains[0])
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

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
)

type serviceConfig struct {
	AppID       string `json:"appId"`
	ServiceName string `json:"serviceName"`
	Revision    string `json:"revision"`
	Enabled     bool   `json:"enabled"`
}
type control struct {
	Version  int             `json:"version"`
	Token    string          `json:"token"`
	Services []serviceConfig `json:"services"`
}
type serviceSnapshot struct {
	AppID       string `json:"appId"`
	ServiceName string `json:"serviceName"`
	Revision    string `json:"revision"`
	State       string `json:"state"`
	Origin      string `json:"origin"`
	Message     string `json:"message"`
}

// Stdin is a private, bounded desired-state protocol. Malformed input fails closed.
func readControl(ctx context.Context, in io.Reader, out chan<- control, cancel context.CancelFunc) {
	defer cancel()
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var c control
		if json.Unmarshal(scanner.Bytes(), &c) != nil || c.Version != 1 || len(c.Token) != 43 || len(c.Services) > 1000 {
			return
		}
		names, ids := map[string]bool{}, map[string]bool{}
		for _, v := range c.Services {
			if !v.Enabled || len(v.AppID) == 0 || len(v.AppID) > 128 || len(v.Revision) == 0 || len(v.Revision) > 128 || tailcfg.ServiceName("svc:"+v.ServiceName).Validate() != nil || names[v.ServiceName] || ids[v.AppID] {
				return
			}
			names[v.ServiceName], ids[v.AppID] = true, true
		}
		select {
		case out <- c:
		case <-ctx.Done():
			return
		}
	}
}

type runningService struct {
	config        serviceConfig
	listener      *tsnet.ServiceListener
	server        *http.Server
	failed        chan struct{}
	token         string
	certReady     atomic.Bool
	certChecking  atomic.Bool
	nextCertCheck time.Time
}
type serviceManager struct {
	running   map[string]*runningService
	certSlots chan struct{}
}

func (m *serviceManager) close() {
	for id, r := range m.running {
		r.listener.Close()
		r.server.Close()
		delete(m.running, id)
	}
}
func approvedServices(st *ipnstate.Status) map[tailcfg.ServiceName]bool {
	result := map[tailcfg.ServiceName]bool{}
	if st == nil || st.Self == nil {
		return result
	}
	for _, raw := range st.Self.CapMap[tailcfg.NodeAttrServiceHost] {
		var mappings tailcfg.ServiceIPMappings
		if json.Unmarshal([]byte(raw), &mappings) != nil {
			continue
		}
		for name, ips := range mappings {
			if len(ips) > 0 {
				result[name] = true
			}
		}
	}
	return result
}

// All ListenService/Close calls run on the main loop to serialize ServeConfig writes.
func (m *serviceManager) reconcile(ctx context.Context, s *tsnet.Server, lc *local.Client, st *ipnstate.Status, target *url.URL, c control) []serviceSnapshot {
	if m.running == nil {
		m.running = map[string]*runningService{}
		m.certSlots = make(chan struct{}, 4)
	}
	wanted := map[string]serviceConfig{}
	for _, v := range c.Services {
		wanted[v.AppID] = v
	}
	for id, r := range m.running {
		v, ok := wanted[id]
		if !ok || v != r.config || r.token != c.Token || st == nil || st.Self == nil || st.BackendState != "Running" || !st.Self.IsTagged() {
			r.listener.Close()
			r.server.Close()
			delete(m.running, id)
		}
	}
	approved := approvedServices(st)
	snapshots := make([]serviceSnapshot, 0, len(c.Services))
	for _, v := range c.Services {
		snap := serviceSnapshot{AppID: v.AppID, ServiceName: v.ServiceName, Revision: v.Revision, State: "starting"}
		if st == nil || st.BackendState != "Running" {
			snapshots = append(snapshots, snap)
			continue
		}
		if st.Self == nil || !st.Self.IsTagged() {
			snap.State = "needs-tag"
			snapshots = append(snapshots, snap)
			continue
		}
		r := m.running[v.AppID]
		if r != nil {
			select {
			case <-r.failed:
				r.listener.Close()
				r.server.Close()
				delete(m.running, v.AppID)
				r = nil
			default:
			}
		}
		if r == nil {
			ln, err := s.ListenService("svc:"+v.ServiceName, tsnet.ServiceModeHTTP{Port: 443, HTTPS: true})
			if err != nil {
				snap.State = "error"
				snap.Message = "Unable to advertise this Service. Check its name, tag identity and HTTPS settings."
				snapshots = append(snapshots, snap)
				continue
			}
			ingress := appProxy(target, c.Token, v.AppID, "https://"+ln.FQDN)
			r = &runningService{config: v, token: c.Token, listener: ln, server: &http.Server{Handler: ingress, ReadHeaderTimeout: 15 * time.Second}, failed: make(chan struct{})}
			m.running[v.AppID] = r
			go func(r *runningService) { r.server.Serve(r.listener); close(r.failed) }(r)
		}
		snap.State = "pending"
		if approved[tailcfg.ServiceName("svc:"+v.ServiceName)] {
			snap.State = "https-pending"
			if r.certReady.Load() {
				snap.State = "ready"
				snap.Origin = "https://" + r.listener.FQDN
			}
			if !r.certChecking.Load() && time.Now().After(r.nextCertCheck) {
				select {
				case m.certSlots <- struct{}{}:
					r.certChecking.Store(true)
					r.nextCertCheck = time.Now().Add(30 * time.Second)
					go func(r *runningService) {
						defer func() { <-m.certSlots; r.certChecking.Store(false) }()
						certCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
						defer cancel()
						_, _, err := lc.CertPair(certCtx, r.listener.FQDN)
						r.certReady.Store(err == nil)
					}(r)
				default:
				}
			}
		} else {
			r.certReady.Store(false)
			r.nextCertCheck = time.Time{}
		}
		snapshots = append(snapshots, snap)
	}
	return snapshots
}
func appProxy(target *url.URL, token, appID, origin string) http.Handler {
	p := proxy(target)
	rewrite := p.Rewrite
	p.Rewrite = func(r *httputil.ProxyRequest) {
		rewrite(r)
		r.Out.Header.Set("X-Forwarded-Host", strings.TrimPrefix(origin, "https://"))
		r.Out.Header.Set("X-Hatch-Ingress-Token", token)
		r.Out.Header.Set("X-Hatch-Ingress-App", appID)
		r.Out.Header.Set("X-Hatch-Ingress-Origin", origin)
	}
	return p
}

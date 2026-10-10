package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestProxyPreservesAuthenticationAndOriginWithoutTrustingIdentityHeaders(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Host, "127.0.0.1:") || r.Header.Get("X-Forwarded-Host") != "hatch.example.ts.net" || r.URL.RequestURI() != "/api/auth/get-session?x=1" {
			t.Errorf("incorrect request destination: %s %s", r.Host, r.URL)
		}
		if r.Header.Get("Cookie") != "session=test" || r.Header.Get("Origin") != "https://hatch.example.ts.net" {
			t.Error("authentication context was not preserved")
		}
		if r.Header.Get("X-Forwarded-Proto") != "https" || r.Header.Get("X-Forwarded-For") == "forged" {
			t.Error("forwarding headers were not replaced")
		}
		if r.Header.Get("Tailscale-User-Login") != "" {
			t.Error("untrusted identity header was forwarded")
		}
		w.Header().Set("Set-Cookie", "session=new; Path=/; HttpOnly")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "ok")
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	r := httptest.NewRequest(http.MethodGet, "https://hatch.example.ts.net/api/auth/get-session?x=1", nil)
	r.Header.Set("Cookie", "session=test")
	r.Header.Set("Origin", "https://hatch.example.ts.net")
	r.Header.Set("X-Forwarded-For", "forged")
	r.Header.Set("Tailscale-User-Login", "owner@example.com")
	w := httptest.NewRecorder()
	proxy(target).ServeHTTP(w, r)
	if w.Code != http.StatusCreated || w.Body.String() != "ok" || w.Header().Get("Set-Cookie") == "" {
		t.Fatal("response or session cookie lost at ingress")
	}
}

func TestProxyStreamsBeforeUpstreamCompletes(t *testing.T) {
	release := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	ingress := httptest.NewServer(proxy(target))
	defer ingress.Close()
	defer close(release)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(ingress.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	chunk := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(resp.Body, chunk); err != nil {
		t.Fatal(err)
	}
	if string(chunk) != "data: first\n\n" {
		t.Fatal("streamed data changed")
	}
}

func TestProxySupportsBidirectionalUpgrades(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "websocket" {
			t.Error("upgrade header lost")
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_, _ = io.Copy(conn, conn)
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	ingress := httptest.NewServer(proxy(target))
	defer ingress.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ingress.URL, nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatal("upgrade refused")
	}
	stream, ok := resp.Body.(io.ReadWriteCloser)
	if !ok {
		t.Fatal("upgraded response is not bidirectional")
	}
	_, _ = stream.Write([]byte("ping"))
	reply := make([]byte, 4)
	if _, err := io.ReadFull(stream, reply); err != nil {
		t.Fatal(err)
	}
	if string(reply) != "ping" {
		t.Fatal("upgrade payload changed")
	}
}

func TestProxyDoesNotRewriteUntrustedOrigin(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "https://attacker.example" {
			t.Error("CSRF origin rewritten")
		}
		w.WriteHeader(http.StatusForbidden)
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	r := httptest.NewRequest(http.MethodPost, "https://hatch.example.ts.net/api/auth/sign-in/email", nil)
	r.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	proxy(target).ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatal("upstream authorization response lost")
	}
}

func TestAppIngressBindsIdentityAndStripsCallerProof(t *testing.T) {
	var got http.Header
	var host string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		host = r.Host
		w.WriteHeader(204)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	ingress := httptest.NewServer(appProxy(target, "private-proof", "app-a", "https://notes.example.ts.net"))
	defer ingress.Close()
	req, _ := http.NewRequest("GET", ingress.URL+"/api/app/app-a/rpc/ping", nil)
	req.Header.Set("X-Hatch-Ingress-App", "app-b")
	req.Header.Set("X-Hatch-Ingress-Token", "attacker")
	req.Header.Set("Tailscale-User-Login", "attacker@example.com")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if got.Get("X-Hatch-Ingress-App") != "app-a" || got.Get("X-Hatch-Ingress-Token") != "private-proof" || got.Get("X-Hatch-Ingress-Origin") != "https://notes.example.ts.net" || got.Get("Tailscale-User-Login") != "" || host != target.Host || got.Get("X-Forwarded-Host") != "notes.example.ts.net" {
		t.Fatal("untrusted ingress identity reached upstream")
	}
}

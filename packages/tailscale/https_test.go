package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/client/local"
)

func TestHTTPSPreparationWaitsAcrossRetriesAndRecoversAfterWarning(t *testing.T) {
	start := time.Now()
	now := start
	certificateReady := false
	listened := 0
	var emitted []snapshot
	p := httpsPreparation{
		certificate: func(context.Context, string) error {
			if len(emitted) == 0 || emitted[0].State != "preparing-https" || emitted[0].HTTPS.Phase != "certificate" || emitted[0].DNS == nil {
				t.Fatal("certificate request started without publishing preparation status")
			}
			if !certificateReady {
				return context.DeadlineExceeded
			}
			return nil
		},
		listen: func() error { listened++; return nil },
		emit:   func(s snapshot) { emitted = append(emitted, s) },
		now:    func() time.Time { return now },
	}
	enabled := true
	p.dns = &dnsStatus{MagicDNSEnabled: &enabled, HTTPSCertificatesEnabled: &enabled}
	for _, elapsed := range []time.Duration{0, time.Minute, httpsPreparationGracePeriod - time.Second} {
		now = start.Add(elapsed)
		status := p.prepare(context.Background(), "hatch.example.ts.net")
		if status.State != "preparing-https" || status.HTTPS.Phase != "certificate" || status.DNS != p.dns || status.Origin != "" || listened != 0 {
			t.Fatalf("certificate retry was treated as failure or ready access: %+v", status)
		}
		logHTTPSStatus(t, status)
	}
	now = p.startedAt.Add(httpsPreparationGracePeriod)
	status := p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "error" || status.HTTPS.Phase != "certificate-delayed" || status.Message == "" || status.Origin != "" {
		t.Fatalf("prolonged failure did not provide troubleshooting guidance: %+v", status)
	}
	logHTTPSStatus(t, status)
	certificateReady = true
	status = p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "connected" || status.HTTPS.Phase != "ready" || status.Origin != "https://hatch.example.ts.net" || status.Message != "" {
		t.Fatalf("certificate preparation did not recover automatically: %+v", status)
	}
	logHTTPSStatus(t, status)
	p.prepare(context.Background(), "hatch.example.ts.net")
	if listened != 1 {
		t.Fatal("ready HTTPS listener was started more than once")
	}
}

func TestCertificateRateLimitWaitsForRetryAfterAndRecovers(t *testing.T) {
	var requests atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "3600")
		if requests.Add(1) == 2 {
			w.Header().Set("Retry-After", "1800")
		}
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer api.Close()
	lc := local.Client{
		Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", api.Listener.Addr().String())
		},
	}
	start := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	now := start
	attempts, listened := 0, 0
	certificateReady := false
	p := httpsPreparation{
		certificate: func(ctx context.Context, domain string) error {
			attempts++
			if certificateReady {
				return nil
			}
			_, _, err := lc.CertPair(ctx, domain)
			return err
		},
		listen: func() error {
			if !certificateReady {
				t.Fatal("listener started without a certificate")
			}
			listened++
			return nil
		},
		emit: func(snapshot) {},
		now:  func() time.Time { return now },
	}
	enabled := true
	p.dns = &dnsStatus{MagicDNSEnabled: &enabled, HTTPSCertificatesEnabled: &enabled}
	status := p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "error" || status.HTTPS.Phase != "rate-limited" || status.HTTPS.RetryAt == nil || *status.HTTPS.RetryAt != "2026-10-12T01:00:00Z" || status.DNS != p.dns || status.Message == "" || status.Origin != "" {
		t.Fatalf("certificate rate limit was hidden as normal preparation: %+v", status)
	}
	logHTTPSStatus(t, status)
	for _, elapsed := range []time.Duration{2 * time.Second, time.Minute, time.Hour - time.Nanosecond} {
		now = start.Add(elapsed)
		if got := p.prepare(context.Background(), "hatch.example.ts.net"); !reflect.DeepEqual(got, status) || attempts != 1 || listened != 0 {
			t.Fatalf("rate-limit pause did not preserve diagnostics without a certificate request: status=%+v attempts=%d listened=%d", got, attempts, listened)
		}
	}
	now = start.Add(time.Hour)
	status = p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "error" || status.HTTPS.Phase != "rate-limited" || status.HTTPS.RetryAt == nil || *status.HTTPS.RetryAt != "2026-10-12T01:30:00Z" || status.DNS != p.dns || status.Origin != "" || attempts != 2 || listened != 0 {
		t.Fatalf("renewed rate limit did not update its retry deadline: status=%+v attempts=%d listened=%d", status, attempts, listened)
	}
	logHTTPSStatus(t, status)
	certificateReady = true
	now = start.Add(90*time.Minute - time.Nanosecond)
	if got := p.prepare(context.Background(), "hatch.example.ts.net"); !reflect.DeepEqual(got, status) || attempts != 2 {
		t.Fatalf("renewed rate limit was not respected: status=%+v attempts=%d", got, attempts)
	}
	now = start.Add(90 * time.Minute)
	status = p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "connected" || status.HTTPS.Phase != "ready" || status.HTTPS.RetryAt != nil || status.DNS != p.dns || status.Origin != "https://hatch.example.ts.net" || status.Message != "" || attempts != 3 || listened != 1 {
		t.Fatalf("certificate request did not recover after rate limiting: status=%+v attempts=%d listened=%d", status, attempts, listened)
	}
	logHTTPSStatus(t, status)
	p.prepare(context.Background(), "hatch.example.ts.net")
	if attempts != 3 || listened != 1 || requests.Load() != 2 {
		t.Fatal("ready HTTPS connection repeated certificate requests or listener setup")
	}
}

func TestHTTPSListenerFailureIsNotReportedAsCertificatePreparation(t *testing.T) {
	p := httpsPreparation{
		certificate: func(context.Context, string) error { return nil },
		listen:      func() error { return errors.New("listener unavailable") },
		emit:        func(snapshot) {},
		now:         time.Now,
	}
	enabled := true
	p.dns = &dnsStatus{MagicDNSEnabled: &enabled, HTTPSCertificatesEnabled: &enabled}
	status := p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "error" || status.HTTPS.Phase != "listener-error" || status.Origin != "" || p.ready {
		t.Fatalf("listener failure was hidden or access was trusted prematurely: %+v", status)
	}
	logHTTPSStatus(t, status)
	p.listen = func() error { return nil }
	if status := p.prepare(context.Background(), "hatch.example.ts.net"); status.State != "connected" {
		t.Fatalf("listener did not recover automatically: %+v", status)
	}
}

func logHTTPSStatus(t *testing.T, status snapshot) {
	t.Helper()
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	t.Log(string(encoded))
}

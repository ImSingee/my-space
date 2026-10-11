package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
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
			if len(emitted) == 0 || emitted[0].State != "preparing-https" {
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
	for _, elapsed := range []time.Duration{0, time.Minute, httpsPreparationGracePeriod - time.Second} {
		now = start.Add(elapsed)
		status := p.prepare(context.Background(), "hatch.example.ts.net")
		if status.State != "preparing-https" || status.Origin != "" || listened != 0 {
			t.Fatalf("certificate retry was treated as failure or ready access: %+v", status)
		}
	}
	now = p.startedAt.Add(httpsPreparationGracePeriod)
	status := p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "error" || status.Message == "" || status.Origin != "" {
		t.Fatalf("prolonged failure did not provide troubleshooting guidance: %+v", status)
	}
	certificateReady = true
	status = p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "connected" || status.Origin != "https://hatch.example.ts.net" || status.Message != "" {
		t.Fatalf("certificate preparation did not recover automatically: %+v", status)
	}
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
	start := time.Now()
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
		listen: func() error { listened++; return nil },
		emit:   func(snapshot) {},
		now:    func() time.Time { return now },
	}
	status := p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "error" || status.Message == "" || status.Origin != "" {
		t.Fatalf("certificate rate limit was hidden as normal preparation: %+v", status)
	}
	for _, elapsed := range []time.Duration{2 * time.Second, time.Minute, time.Hour - time.Nanosecond} {
		now = start.Add(elapsed)
		if got := p.prepare(context.Background(), "hatch.example.ts.net"); got != status || attempts != 1 || listened != 0 {
			t.Fatalf("rate-limit pause did not preserve warning without a certificate request: status=%+v attempts=%d listened=%d", got, attempts, listened)
		}
	}
	now = start.Add(time.Hour)
	if got := p.prepare(context.Background(), "hatch.example.ts.net"); got != status || attempts != 2 || listened != 0 {
		t.Fatalf("certificate request did not resume at the retry deadline: status=%+v attempts=%d listened=%d", got, attempts, listened)
	}
	certificateReady = true
	now = start.Add(90*time.Minute - time.Nanosecond)
	if got := p.prepare(context.Background(), "hatch.example.ts.net"); got != status || attempts != 2 {
		t.Fatalf("renewed rate limit was not respected: status=%+v attempts=%d", got, attempts)
	}
	now = start.Add(90 * time.Minute)
	status = p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "connected" || status.Origin != "https://hatch.example.ts.net" || status.Message != "" || attempts != 3 || listened != 1 {
		t.Fatalf("certificate request did not recover after rate limiting: status=%+v attempts=%d listened=%d", status, attempts, listened)
	}
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
	status := p.prepare(context.Background(), "hatch.example.ts.net")
	if status.State != "error" || status.Origin != "" || p.ready {
		t.Fatalf("listener failure was hidden or access was trusted prematurely: %+v", status)
	}
	p.listen = func() error { return nil }
	if status := p.prepare(context.Background(), "hatch.example.ts.net"); status.State != "connected" {
		t.Fatalf("listener did not recover automatically: %+v", status)
	}
}

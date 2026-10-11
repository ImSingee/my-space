package main

import (
	"context"
	"time"

	"tailscale.com/client/local"
)

const httpsPreparationGracePeriod = 5 * time.Minute

// Certificate issuance can span several attempts before the private address is ready.
type httpsPreparation struct {
	certificate func(context.Context, string) error
	listen      func() error
	emit        func(snapshot)
	now         func() time.Time
	startedAt   time.Time
	retryAt     time.Time
	ready       bool
}

func (p *httpsPreparation) waiting() snapshot {
	if p.now().Sub(p.startedAt) >= httpsPreparationGracePeriod {
		return snapshot{State: "error", Message: "Your device is connected to Tailscale, but its HTTPS certificate is taking longer than expected. Hatch is still retrying automatically. Check this installation’s internet connection and Tailscale DNS settings."}
	}
	return snapshot{State: "preparing-https"}
}

func (p *httpsPreparation) prepare(ctx context.Context, domain string) snapshot {
	connected := snapshot{State: "connected", Origin: "https://" + domain}
	if p.ready {
		return connected
	}
	rateLimitWarning := snapshot{State: "error", Message: "The certificate provider has temporarily limited HTTPS certificate requests. Hatch will retry automatically. Reconnecting will not speed this up."}
	if p.now().Before(p.retryAt) {
		return rateLimitWarning
	}
	p.retryAt = time.Time{}
	if p.startedAt.IsZero() {
		p.startedAt = p.now()
		// Publish progress before the first blocking certificate request.
		p.emit(p.waiting())
	}
	if err := p.certificate(ctx, domain); err != nil {
		if retryAfter, limited := local.RateLimitRetryAfter(err); limited {
			p.retryAt = p.now().Add(retryAfter)
			return rateLimitWarning
		}
		return p.waiting()
	}
	if err := p.listen(); err != nil {
		return snapshot{State: "error", Message: "Your HTTPS certificate is ready, but Hatch could not start its private HTTPS listener. Retrying automatically."}
	}
	p.ready = true
	return connected
}

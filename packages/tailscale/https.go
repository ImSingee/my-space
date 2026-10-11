package main

import (
	"context"
	"time"

	"tailscale.com/client/local"
)

const httpsPreparationGracePeriod = 5 * time.Minute

type httpsStatus struct {
	Phase   string  `json:"phase"`
	RetryAt *string `json:"retryAt"`
}

// Certificate issuance can span several attempts before the private address is ready.
type httpsPreparation struct {
	certificate func(context.Context, string) error
	listen      func() error
	emit        func(snapshot)
	now         func() time.Time
	startedAt   time.Time
	retryAt     time.Time
	ready       bool
	dns         *dnsStatus
}

func (p *httpsPreparation) status(state, phase, message string) snapshot {
	return snapshot{State: state, DNS: p.dns, HTTPS: &httpsStatus{Phase: phase}, Message: message}
}

func (p *httpsPreparation) waiting() snapshot {
	if p.now().Sub(p.startedAt) >= httpsPreparationGracePeriod {
		return p.status("error", "certificate-delayed", "Your device is connected to Tailscale, but its HTTPS certificate is taking longer than expected. Hatch is still retrying automatically. Check this installation’s internet connection and Tailscale DNS settings.")
	}
	return p.status("preparing-https", "certificate", "")
}

func (p *httpsPreparation) rateLimited() snapshot {
	v := p.status("error", "rate-limited", "The certificate provider has temporarily limited HTTPS certificate requests. Hatch will retry automatically. Reconnecting will not speed this up.")
	if !p.retryAt.IsZero() {
		retryAt := p.retryAt.UTC().Format(time.RFC3339)
		v.HTTPS.RetryAt = &retryAt
	}
	return v
}

func (p *httpsPreparation) prepare(ctx context.Context, domain string) snapshot {
	connected := p.status("connected", "ready", "")
	connected.Origin = "https://" + domain
	if p.ready {
		return connected
	}
	if p.now().Before(p.retryAt) {
		return p.rateLimited()
	}
	p.retryAt = time.Time{}
	if p.startedAt.IsZero() {
		p.startedAt = p.now()
		// Publish progress before the first blocking certificate request.
		p.emit(p.waiting())
	}
	if err := p.certificate(ctx, domain); err != nil {
		if retryAfter, limited := local.RateLimitRetryAfter(err); limited {
			if retryAfter > 0 {
				p.retryAt = p.now().Add(retryAfter)
			}
			return p.rateLimited()
		}
		return p.waiting()
	}
	if err := p.listen(); err != nil {
		return p.status("error", "listener-error", "Your HTTPS certificate is ready, but Hatch could not start its private HTTPS listener. Retrying automatically.")
	}
	p.ready = true
	return connected
}

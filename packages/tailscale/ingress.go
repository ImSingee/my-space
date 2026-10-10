package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// The ingress only forwards HTTP. Node enrollment and listener ownership live
// in main; application routing and authentication remain in the Platform.
func proxy(target *url.URL) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			// The local listener (including Vite's Host guard) only receives its
			// loopback authority. Keep the browser authority in forwarding metadata.
			r.Out.Host = target.Host
			r.SetXForwarded()
			r.Out.Header.Set("X-Forwarded-Proto", "https")
			// Identity headers are not an authentication mechanism for Hatch.
			for name := range r.Out.Header {
				if strings.HasPrefix(strings.ToLower(name), "tailscale-") || strings.HasPrefix(strings.ToLower(name), "x-hatch-ingress-") {
					r.Out.Header.Del(name)
				}
			}
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Hatch is temporarily unavailable.", http.StatusBadGateway)
		},
	}
}

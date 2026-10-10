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
			r.Out.Host = r.In.Host
			r.SetXForwarded()
			r.Out.Header.Set("X-Forwarded-Proto", "https")
			// Identity headers are not an authentication mechanism for Hatch.
			for name := range r.Out.Header {
				if strings.HasPrefix(strings.ToLower(name), "tailscale-") {
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

package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

func TestControlProtocolRejectsAmbiguousOrUnboundedIdentity(t *testing.T) {
	valid := control{Version: 1, Token: strings.Repeat("t", 43), Services: []serviceConfig{{AppID: "app-a", ServiceName: "notes", Revision: "one", Enabled: true}}}
	for _, name := range []string{"valid", "duplicate-app", "duplicate-name", "invalid-name", "missing-proof", "unknown-version"} {
		c := valid
		c.Services = append([]serviceConfig(nil), valid.Services...)
		switch name {
		case "duplicate-app":
			c.Services = append(c.Services, serviceConfig{AppID: "app-a", ServiceName: "tasks", Revision: "two", Enabled: true})
		case "duplicate-name":
			c.Services = append(c.Services, serviceConfig{AppID: "app-b", ServiceName: "notes", Revision: "two", Enabled: true})
		case "invalid-name":
			c.Services[0].ServiceName = "../notes"
		case "missing-proof":
			c.Token = ""
		case "unknown-version":
			c.Version = 2
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			frames := make(chan control, 1)
			raw, _ := json.Marshal(c)
			readControl(ctx, strings.NewReader(string(raw)+"\n"), frames, cancel)
			expected := 0
			if name == "valid" {
				expected = 1
			}
			if len(frames) != expected {
				t.Fatalf("accepted ambiguous control: %s", name)
			}
			if ctx.Err() == nil {
				t.Fatal("control EOF did not close ingress")
			}
		})
	}
}
func TestServiceApprovalRequiresAnAssignedVIPInSelfCapabilities(t *testing.T) {
	st := &ipnstate.Status{Self: &ipnstate.PeerStatus{CapMap: tailcfg.NodeCapMap{tailcfg.NodeAttrServiceHost: []tailcfg.RawMessage{`{"svc:notes":["100.64.0.10"],"svc:tasks":[]}`}}}}
	approved := approvedServices(st)
	if !approved["svc:notes"] || approved["svc:tasks"] {
		t.Fatal("approval is not bound to assigned Service IPs")
	}
	if len(approvedServices(nil)) != 0 {
		t.Fatal("missing status inferred approval")
	}
}

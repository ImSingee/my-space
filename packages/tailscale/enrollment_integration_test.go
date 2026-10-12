package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/logger"
)

// Run the actual helper entry point in a child so stdin, EOF and shutdown are
// exercised independently of the test runner's flags and process lifetime.
func TestEnrollmentHelperProcess(t *testing.T) {
	if os.Getenv("HATCH_ENROLLMENT_TEST_PROCESS") != "1" {
		return
	}
	netns.SetEnabled(false)
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{"hatch-tailscale"}, os.Args[i+1:]...)
			break
		}
	}
	flag.CommandLine = flag.NewFlagSet("hatch-tailscale", flag.ExitOnError)
	main()
	os.Exit(0)
}

func TestAuthKeyEnrollmentAgainstControlPlane(t *testing.T) {
	control := &testcontrol.Server{
		RequireAuthKey:     "accepted-fixture-key",
		RequireMachineAuth: true,
		DERPMap:            &tailcfg.DERPMap{},
		Logf:               logger.Discard,
	}
	server := httptest.NewServer(control)
	defer server.Close()
	t.Setenv("TS_CONTROL_URL", server.URL)
	t.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	t.Setenv("TS_AUTHKEY", "")
	t.Setenv("TS_AUTH_KEY", "")
	t.Setenv("HATCH_ENROLLMENT_TEST_PROCESS", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, key, state string }{
		{"rejected", "rejected-fixture-key", "error"},
		{"accepted-awaiting-approval", "accepted-fixture-key", "needs-approval"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, executable, "-test.run=^TestEnrollmentHelperProcess$", "--", "--state-dir", t.TempDir(), "--hostname", "hatch-fixture", "--auth-key-stdin")
			cmd.Env = os.Environ()
			var diagnostics bytes.Buffer
			cmd.Stderr = &diagnostics
			input, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			output, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer cmd.Process.Kill()
			if err := json.NewEncoder(input).Encode(map[string]string{"authKey": tc.key}); err != nil {
				t.Fatal(err)
			}
			decoder := json.NewDecoder(output)
			for {
				var got snapshot
				if err := decoder.Decode(&got); err != nil {
					t.Fatalf("helper did not reach %s: %v", tc.state, err)
				}
				if got.LoginURL != "" || strings.Contains(got.Message, tc.key) {
					t.Fatal("helper exposed enrollment credentials or an interactive login URL")
				}
				if got.State != tc.state {
					continue
				}
				if tc.state == "error" && !strings.Contains(got.Message, "Auth key sign-in failed") {
					t.Fatalf("unexpected failure: %s", got.Message)
				}
				t.Logf("key enrollment reached %s without an authorization URL", got.State)
				break
			}
			_ = input.Close()
			if err := cmd.Wait(); err != nil {
				t.Fatalf("helper did not shut down on stdin EOF: %v", err)
			}
			if strings.Contains(diagnostics.String(), tc.key) {
				t.Fatal("helper logged the enrollment key")
			}
		})
	}
	if len(control.AllNodes()) != 1 {
		t.Fatal("accepted key did not register exactly one node")
	}
}

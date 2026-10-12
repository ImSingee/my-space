package main

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestEnrollmentPipeContract(t *testing.T) {
	message, _ := json.Marshal(map[string]string{"authKey": "tskey-auth-fixture"})
	reader, key, err := readEnrollment(strings.NewReader(string(message)+"\nparent-alive"), true)
	if err != nil || key != "tskey-auth-fixture" {
		t.Fatal("explicit enrollment credentials were not read")
	}
	remainder, err := io.ReadAll(reader)
	if err != nil || string(remainder) != "parent-alive" {
		t.Fatal("parent-death monitor lost buffered input")
	}
	reader, key, err = readEnrollment(strings.NewReader("parent-alive"), false)
	if err != nil || key != "" {
		t.Fatal("interactive startup required enrollment credentials")
	}
	remainder, _ = io.ReadAll(reader)
	if string(remainder) != "parent-alive" {
		t.Fatal("interactive startup consumed the lifecycle channel")
	}
}

func TestEnrollmentRejectsMalformedInputWithoutEchoingSecrets(t *testing.T) {
	for _, input := range []string{
		"",
		"{\"authKey\":\"secret-fixture\"}",
		"secret-fixture\n",
		"{\"authKey\":\"\"}\n",
		"{\"authKey\":\"secret fixture\"}\n",
		"{\"authKey\":\"" + strings.Repeat("x", 4097) + "\"}\n",
		strings.Repeat("x", 16384) + "\n",
	} {
		_, key, err := readEnrollment(strings.NewReader(input), true)
		if err == nil || key != "" || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid enrollment input was accepted or exposed")
		}
	}
}

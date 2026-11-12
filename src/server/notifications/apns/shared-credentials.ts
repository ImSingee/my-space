/**
 * APNs credentials shared by every self-hosted Hatch instance so it can push
 * to the official Hatch iOS app without operating a relay (the model Bark
 * uses).
 *
 * The keys are Apple *topic-specific* keys restricted to the
 * `app.hatch.mobile` topic and to one environment each, so they cannot push to
 * any other app of the team. A leaked key alone cannot reach a device: a
 * sender also needs that device's token, and notification content is
 * end-to-end encrypted with a per-device key that only the device and its own
 * instance know (see `docs/notifications.md`).
 *
 * `null` means the built-in key for that environment has not been published
 * yet; instances can still configure their own via `HATCH_APNS_*`.
 */
export type SharedApnsKey = { keyId: string; privateKey: string };

export const SHARED_APNS_CREDENTIALS: {
  teamId: string | null;
  topic: string;
  production: SharedApnsKey | null;
  sandbox: SharedApnsKey | null;
} = {
  teamId: 'SM96W8VVK9',
  topic: 'app.hatch.mobile',
  production: {
    keyId: '463HW3DLQ6',
    privateKey: `-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgS1JhsW0zvNteGbfb
jlP/fzFFpTVN8LWuGDmxryCN6h2gCgYIKoZIzj0DAQehRANCAAQJFxkPLDI9hhuW
Ky+TBrLWUF3Jj0Gyl5uxkw3uExM387O7U/oNkxkDH3NDGBKDW9cuSAq2G5f6qh+2
HCbx87SF
-----END PRIVATE KEY-----`,
  },
  sandbox: {
    keyId: 'GG5C9RXW3V',
    privateKey: `-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgjSn7rO96IzcqYxCi
3yb1kTbe/oaHf+qrtfsIVBaej+igCgYIKoZIzj0DAQehRANCAATFwhdO3T/iwhyB
CKn/knA+/bkq5NX0e4hmRZbI/yLMHEHJBnPKgM0jDTO3Hs7CQfi7MvaJ2Kn2oUuH
bwfbi+Qr
-----END PRIVATE KEY-----`,
  },
};

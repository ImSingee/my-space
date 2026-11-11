# iOS releases with Expo EAS

Run release commands from the repository root. The app uses the pinned EAS CLI
through `pnpm dlx`, independently of the app's runtime dependencies. Optional
CLI dependency install scripts are disabled.

The app is linked to `@singee/hatch-mobile` (project ID
`2ed99159-8abc-41eb-91a5-c6c754bb4354`). Production signing uses the existing
Apple Distribution certificate and Hatch App Store provisioning profile stored
in EAS, both expiring October 17, 2027. EAS Submit reuses the account's existing
App Store Connect API key. Local copies of exported signing credentials are not
required for releases.

## One-time account setup

1. Log in to the Expo account that will own the project:

   ```sh
   pnpm --dir mobile eas login --device
   ```

2. Confirm the configured project with `pnpm --dir mobile eas project:info`.
   Normal releases keep the existing `extra.eas.projectId` in
   `mobile/app.config.ts`; running `eas init` alone does not select a replacement.

   To deliberately replace the Expo project, first record its existing owner,
   slug, and project ID for recovery. In `mobile/app.config.ts`, remove only
   `extra.eas.projectId` and set `owner` and `slug` for the intended account and
   project. Run `pnpm --dir mobile eas init --account <account>` to create or
   select that project, then write the returned project ID into the dynamic
   config manually and verify it with `project:info`. Alternatively, if the
   replacement already exists, set its owner, slug, and known project ID
   together in the config and verify them. The Apple app ID and bundle identifier
   stay the same when replacing only the Expo project.

   A replacement has separate remote build numbering and project credential
   assignments. Complete the next two steps for that project before releasing.
   Restoring the recorded config points the local app back at the original
   project; it does not transfer remote builds or credentials.

3. Initialize the remote iOS build number with
   `pnpm --dir mobile eas build:version:set --platform ios --profile production`.
   Enter the latest build number already uploaded to Apple. This project was
   initialized with `3`; do not reset the counter during normal releases.
   Each production build increments it automatically, including a build that
   subsequently fails.

4. Run `pnpm --dir mobile eas credentials --platform ios` and choose the
   production profile. Reuse the existing distribution certificate and App
   Store provisioning profile for `app.hatch.mobile`. Reuse an existing EAS
   Submit API key when available. Do not revoke working credentials to set up
   this project.

   Remote signing requires authorizing Expo to store the signing credentials;
   unattended submission requires an App Store Connect API key assigned to
   this Expo project. Confirm the account, key permissions, and credential
   transfer before performing that setup. A local `.p8`, `.p12`, or
   `credentials.json` must never enter Git or the build source archive.

## Build and submit

```sh
pnpm mobile:release:ios
```

This uses `build.production` and `submit.production` in `mobile/eas.json`:

- Store-signed Release build, with an automatically incremented remote build
  number. The user-facing version stays in `mobile/app.config.ts`.
- Existing Apple app `6830081962`, bundle ID `app.hatch.mobile`, team
  `SM96W8VVK9`.
- Submission to the existing `Singee Internal` TestFlight group. It does not
  submit the app for public App Store review.

An existing store-signed IPA can be submitted without rebuilding:

```sh
pnpm mobile:submit:ios --path /absolute/path/Hatch.ipa
```

The IPA must have a build number Apple has not already accepted. Do not submit
the same released build again to test the configuration.

## Source archive and completion

EAS runs from `mobile/` but archives the monorepo root. The root `.easignore`
includes the app, shared Platform API, package-manager files, dependency patches,
and app icon. It excludes backend sources, local credentials, generated native
projects, databases, and `.acceptances/`. EAS generates the native project from
the Expo config and config plugins.

Inspect the upload before changing its scope:

```sh
pnpm --dir mobile eas build:inspect --platform ios --profile production \
  --stage archive --output /tmp/hatch-eas-archive
```

Wait for Apple processing after submission. A release is available only after
the build is shown as Testing in the intended TestFlight group. A queued EAS
build or successful upload alone does not prove tester availability.

## References

- [Expo iOS submission](https://docs.expo.dev/submit/ios/)
- [Remote build numbers](https://docs.expo.dev/build-reference/app-versions/)
- [Monorepo builds](https://docs.expo.dev/build-reference/build-with-monorepos/)

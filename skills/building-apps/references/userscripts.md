# Userscripts

Read this reference when publishing Tampermonkey scripts from an App.

Enable `userscripts` and declare a top-level `userscripts` array. A userscript
does not require a backend. Hatch bundles each TypeScript entry as an IIFE and
serves a tokenized `.user.js` install/update URL from the App management page.

```json
{
  "capabilities": { "userscripts": true },
  "userscripts": [
    {
      "id": "price-watch",
      "name": "Price Watch",
      "entry": "userscripts/price-watch.ts",
      "matches": ["https://example.com/*"],
      "description": "Highlight price drops",
      "grants": ["GM_xmlhttpRequest", "GM_setValue", "GM_getValue"],
      "connects": ["api.example.com"],
      "runAt": "document-idle",
      "noframes": true,
      "extraMetadata": {
        "require": "https://code.jquery.com/jquery-3.7.1.min.js"
      }
    }
  ]
}
```

- `id` uses letters, digits, `-`, or `_` and becomes a URL/file segment.
- `matches` contains at least one Tampermonkey `@match` pattern.
- `entry` is normal browser TypeScript. Add npm dependencies to `package.json`
  and import them normally; Hatch bundles them.
- Do not write a metadata block in source. Hatch owns `@name`, `@namespace`,
  `@version`, update/download URLs, page scope, grants, connects, run timing,
  noframes, and description.
- `grants` maps to `@grant`; `['none']` selects page context and cannot be mixed
  with real grants. `connects` maps to allowed `GM_xmlhttpRequest` hosts.
- Use `extraMetadata` only for additional directives such as `require`,
  `resource`, or `icon`; it cannot override platform-owned fields.
- The private install URL contains an App token. Treat it as a secret. Hatch
  increments the userscript version on deploy and rollback for auto-updates.

To send data to the App, call an absolute App endpoint through
`GM_xmlhttpRequest` and include its host in `connects`. Relative URLs target the
third-party page, not Hatch.

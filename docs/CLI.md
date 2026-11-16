# Offline WGIF CLI — v0.1 RC1

After applying the included package-lock patch, then running `npm ci && npm run build`, the command is available through the `@wgif/format` workspace `bin` mapping. If your workspace package manager has not linked that bin, invoke the compiled file directly using `node packages/format/dist/src/cli.js` instead of `wgif`.

```sh
wgif validate examples/court/court.wgif
wgif inspect examples/court/court.wgif
wgif pack ./my-world-folder --out ./my-world.wgif
wgif sign ./my-world.wgif --key ./my-local-seed-file --out ./my-signed-world.wgif
```

`pack` expects a UTF-8 `manifest.json` plus the referenced payload files rooted under the input directory. It rejects symlinks, recomputes `files[]`, and refuses an existing signature because rebuilding a signed archive can invalidate the hash list. `validate` exits nonzero on format errors; optional warnings do not make a file invalid. `inspect` prints metadata, never raw payloads or private keys. `sign` requires a fully valid input and a **local** 32-byte ed25519 private seed file or a file containing its 64-character hexadecimal representation. It writes a **new file** by default and verifies the signature before reporting success.

Never add a private seed to a repository or share it with others. Do not log key contents. Keys are not distributed with this repository, its tests, its example worlds or the interoperability corpus. No network access is used by any command.

For tests: `npm run test --workspace @wgif/format` (Vitest). For the complete gate: `npm run lint && npm run typecheck && npm test && npm run build`.

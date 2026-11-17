# WGIF v0.1 player interoperability corpus

`good-*.wgif` MUST validate and `bad-*.wgif` MUST fail (either with a ZIP read exception or a validation error). `expected.json` lists the expected classifications. All worlds are deliberately tiny, handcrafted, offline and contain **no credentials, signatures or executable code** except for the intentional `bad-executable.wgif` reject test (a harmless inert string, never executed).

`build_fixtures.py` uses only the Python standard library and writes deterministic ZIP files. To rebuild: `python tests/fixtures/build_fixtures.py`. ZIPs store `manifest.json` first and uncompressed unless the test intentionally violates the rule. The good GLB is a minimal valid glTF 2.0 asset; the preview is a 1×1 PNG.

Intended reject cases:

- `bad-notzip`, `bad-truncated`, `bad-duplicate`, `bad-missing-manifest`, `bad-compressed-manifest`, `bad-traversal`, `bad-prototype`: ZIP/container preflight errors.
- `bad-hash`, `bad-json`, `bad-interactions`, `bad-state`, `bad-layer`, `bad-executable`, `bad-major`: semantic world validation errors.

These are protocol tests, not malware samples. A player MUST NOT execute any contained data as a script.

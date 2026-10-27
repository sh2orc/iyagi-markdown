# Release notes

Installers are published as [GitHub Releases](https://github.com/sh2orc/iyagi-markdown/releases),
one release per version (tag `v<version>`), and the latest is linked from the download
sections of [README.md](README.md#download) and [README_KR.md](README_KR.md#다운로드) with
its SHA-256.

## Publishing a release

1. **Bump the version** in `Cargo.toml` (`[workspace.package]`), `package.json` and
   `package-lock.json` (`npm version <v> --no-git-tag-version`) and
   `src-tauri/tauri.conf.json`, then refresh the lockfile with `cargo update -w`.
2. **Build** on the release Mac: `npm run tauri build`. `scripts/tauri.mjs` signs the bundle
   with the sole Developer ID Application certificate in the login keychain and enables
   hardened runtime. The DMG lands in `target/release/bundle/dmg/`.
3. **Notarize and staple** the DMG, then check that `spctl` reports
   `source=Notarized Developer ID` for the DMG and the app inside it:

   ```sh
   xcrun notarytool submit <dmg> --keychain-profile iyagi-notary --wait
   xcrun stapler staple <dmg>
   spctl -a -t open --context context:primary-signature -v <dmg>
   ```

4. **Record the hash and notes.** `shasum -a 256` the DMG, add the release notes below, and
   update the download sections of `README.md` and `README_KR.md`. Commit and push to `main`.
5. **Publish** the GitHub release from that commit, attaching the DMG under its dotted name:

   ```sh
   cp target/release/bundle/dmg/IYAGI.Markdown_<v>_aarch64.dmg /tmp/
   gh release create v<v> /tmp/IYAGI.Markdown_<v>_aarch64.dmg \
     --target main --title 'IYAGI Markdown <v>' --notes-file <notes.md> --latest
   ```

6. **Verify** the published asset: download it from the release page and compare
   `shasum -a 256` with the recorded hash and the digest GitHub shows.

README download buttons point to `releases/latest`, so they follow the newest release; the
direct file links in the tables point to the exact tag. Tag pushes also trigger the
protected-ref CI jobs ([.github/workflows/ci.yml](.github/workflows/ci.yml)), including the
macOS DMG bundle build.

## Trust posture (as of 0.1.0)

macOS installers are signed with a Developer ID, built with hardened runtime and notarized,
with the notarization ticket stapled to the DMG, so they open without Gatekeeper warnings.
They are still built on a developer machine rather than in CI.

The SHA-256 is recorded in this file and the READMEs, and GitHub computes its own digest for
each release asset. Both sit under the same GitHub account as the installer, so they detect
transport corruption, not a compromise of that account.

## Release integrity roadmap

- [x] **Developer ID signing + notarization (macOS)** — since 0.1.0.
- [ ] **CI-built releases on protected refs** — build and publish the installer from a
      protected tag in CI, never from a developer machine. Needs a self-hosted macOS runner
      with the signing identity.
- [ ] **Independent hash/signature channel** — publish build provenance or signatures that
      do not depend on the same account.

## 0.1.0 — 2026-10-27

First public release.

- Live-preview Markdown editor on CodeMirror 6 — source-preserving, markers reveal only
  under the caret, in-place widget editing
- GFM tables (in-place cell editing, rectangular multi-select, merges, captions), task
  lists, strikethrough, footnotes
- Note system — wikilinks, backlinks, embeds, callouts, tags, graph, daily notes, heading
  rename with workspace-wide link updates
- Per-document styles in a SQLite sidecar, applied identically to editor, HTML, PDF, DOCX
- Exports — self-contained HTML, vector PDF, DOCX (OMML, DrawingML, comments, footnotes,
  multi-column, headers/footers), EPUB 3
- Review hub, track changes, version snapshots, citations, templates, multi-cursor, smart
  paste, recovery drafts
- Korean and English UI

| Platform | File | SHA-256 |
|---|---|---|
| macOS · Apple Silicon | [`IYAGI.Markdown_0.1.0_aarch64.dmg`](https://github.com/sh2orc/iyagi-markdown/releases/download/v0.1.0/IYAGI.Markdown_0.1.0_aarch64.dmg) | `8330ed4d0e27fe656fc82605bb33d2d44e80c0cda1305cf894ea9c89d633f83c` |

Signed with Developer ID and notarized; the ticket is stapled to the DMG.


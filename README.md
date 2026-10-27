# IYAGI Markdown

**Your Interface to AGI** — Read, write, and keep your Markdown intact.

English | **[한국어](README_KR.md)** · [Download](#download) · [Release notes](RELEASE.md)

IYAGI Markdown is a lightweight macOS Markdown reader/editor. Double-click a `.md` file and
it opens rendered, tidy and ready — and the same window edits and saves it. Built on
Tauri 2 + Rust + React/TS + CodeMirror 6.

- **Lossless source.** The document is always Markdown text and nothing else. Saving writes
  the buffer atomically (temp file → rename). BOM, CRLF/LF and the trailing newline are
  preserved, and an unmodified document is never written. There is no HTML-conversion
  editing path.
- **Live preview (WYSIWYG).** Headings, emphasis, links, tables, checkboxes, images, math
  (KaTeX) and diagrams (mermaid) render as CodeMirror 6 decorations and widgets. Inline
  markers (`**` and friends) reveal their source only while the caret or a selection endpoint
  touches them — ⌘A or a wide drag keeps the rendering intact with the highlight simply
  layered on top (Typora-style). Widgets (table cells, math, diagrams, front matter) open
  their source position on click. Headings are created with `#`/`##` (ATX) only — underlined
  (Setext, `---`/`===`) lines are not headings: at typing time they are separated by a blank
  line (Word-style) and `---` becomes a horizontal rule. External documents that were never
  separated still render as paragraph + rule, and exports apply the same interpretation by
  inserting blank lines to normalize the pair.
- **Faithful output.** Diagrams and math in exports are always native vector, editable
  objects of the target format: vector paths in PDF, DrawingML shape groups and OMML math in
  DOCX. No rasterization, ever.
- **Lightweight.** 14 MB (.app) · KaTeX, mermaid and highlight.js are lazy-loaded
  chunks · every caret move recomputes only 1–2 chunks, regardless of document size.

## Download

Installers are published as **[GitHub Releases](https://github.com/sh2orc/iyagi-markdown/releases)**.

**Latest: [0.1.0](https://github.com/sh2orc/iyagi-markdown/releases/tag/v0.1.0)** (2026-10-27)
— the first public release. See [what's new](#whats-new-in-010).

[![Download for macOS](https://img.shields.io/badge/Download-macOS%20%C2%B7%20Apple%20Silicon-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/sh2orc/iyagi-markdown/releases/latest)

| Platform | File | Size | SHA-256 |
|---|---|---|---|
| macOS · Apple Silicon | [`IYAGI.Markdown_0.1.0_aarch64.dmg`](https://github.com/sh2orc/iyagi-markdown/releases/download/v0.1.0/IYAGI.Markdown_0.1.0_aarch64.dmg) | 7.9 MB | `8330ed4d0e27fe656fc82605bb33d2d44e80c0cda1305cf894ea9c89d633f83c` |

Check the download before opening it:

```sh
shasum -a 256 ~/Downloads/IYAGI.Markdown_0.1.0_aarch64.dmg
```

The result must match the hash above, the hash in [RELEASE.md](RELEASE.md) and the digest
GitHub shows next to the asset on the release page.

<details>
<summary>Signing & trust on macOS</summary>

The app and the DMG are signed with a Developer ID, built with hardened runtime and
notarized, with the ticket stapled to the DMG, so it opens without Gatekeeper warnings.

Installers are still built and notarized on a release Mac rather than in CI. The
release-integrity roadmap — CI-built releases on protected tags, an independent hash
channel — is in [RELEASE.md](RELEASE.md).
</details>

<details>
<summary>Requirements & building from source</summary>

macOS 13.0 or later, Apple Silicon. IYAGI Markdown is a macOS-only app; CI
([.github/workflows/ci.yml](.github/workflows/ci.yml)) also checks the OS-independent Rust
core (md-core, md-export) on Linux.

From source: `npm ci && npm run tauri build` (see [Development](#development)).
</details>

## What's new in 0.1.0

First public release:

- Live-preview Markdown editor on CodeMirror 6 — the source is never converted, markers
  reveal only under the caret (Typora-style), widgets edit in place on click
- GFM tables with in-place cell editing, rectangular multi-select, merges and captions;
  task lists, strikethrough, footnotes
- Note system — wikilinks and backlinks, note embeds, callouts, tags, document graph,
  daily notes, heading rename with workspace-wide link updates
- Per-document styles (fonts, spacing, presets) in a SQLite sidecar — the source stays
  untouched — applied identically to the editor, HTML, PDF and DOCX
- Exports: self-contained HTML, vector PDF, DOCX (OMML math, DrawingML diagrams, native
  comments, footnotes, multi-column, headers/footers), EPUB 3
- Review hub, track changes, version snapshots, citations & bibliography, templates,
  multi-cursor, smart paste, recovery drafts
- Korean and English UI; Korean word boundaries in find & replace

## Quick start

1. Open the DMG and drag **IYAGI Markdown** into Applications.
2. Double-click any `.md`/`.markdown` file — it opens rendered. Or use File › Open, drop a
   file onto the Dock icon, or pick from the start screen.
3. Live preview is the default. Switch to read mode with ⌘E and to raw source with ⌘/.
4. Everything lives in the command palette: ⌘⇧P. Print preview ⌘P, folder-wide search ⌘⇧F,
   quick open from the palette.

## Why IYAGI Markdown

Most Markdown editors quietly trade away the two things a `.md` file is for: the source
and the output. IYAGI Markdown keeps both honest:

- **The file on disk is the document.** No database, no lock-in, no HTML round-trip. Saves
  are atomic (temp file → rename), bytes are preserved (BOM, line endings, final newline),
  and an unmodified document is never written.
- **What you see is what is in the file.** Live preview is a view over the text, not a
  conversion of it — every rendering is rebuildable from the bytes on disk.
- **Exports stay editable.** Math and diagrams export as native objects of the target
  format — vector paths in PDF, OMML and DrawingML in DOCX — never as rasterized pictures.
- **Small stays small.** A 14 MB app, lazy-loaded heavy renderers, and incremental
  decoration updates that cost the same on a 10-page and a 500-page document.


## Features

**Document editing**

- File association (`.md`/`.markdown`) — double-click, Dock drop, `open -a`, File › Open
- Start screen — recent documents and template shortcuts when no document is open
- Recent folders — reopen from the sidebar, start screen or command palette; keeps up to 20
  across restarts, synced between windows; remove or clear from the list only
- Template picker — searchable from the start screen and command palette; preview the source
  before creating in a new tab. 8 Korean/English templates (incl. project plan, weekly plan,
  decision record), stamped with the local date at creation
- My templates — save the current document's source or write a new one; edit name,
  description and body, delete; concurrent-edit protection keeps a separate copy per window.
  Up to 100 locally, 512 KiB each; image files are not copied
- Template backup & move — export selected user templates as JSON and review sources on
  import; bulk-add without overwriting existing entries; up to 64 MiB per file
- GFM: tables (in-place cell editing, Word-style — click and type; Tab/Enter move between
  cells; Esc cancels; header-click alignment; column-width drag; row/column editing;
  auto-formatting; tidy-on-save option), task lists, strikethrough, footnotes
- Rectangular multi-select in table cells — drag, ⇧-click, arrow moves, ⇧-arrow extends;
  Enter/⇧Enter edit (↓/↑), Esc then restart, Delete clears, ⌘C copies TSV, table context menu
  (right-click/⇧F10) — fully keyboard-driven, view follows the active cell
- Merged table cells — merge a selection into one cell (`>` left / `^` above markers,
  app-render only — degrade to marker text in other renderers) and unmerge
- Formatting toolbar, selection mini-bar (B/I/S/code/link), right-click context menu
- List continuation (Enter), Tab indent, move line (⌥↑↓), duplicate (⌘D), delete (⌘⇧K)
- Multi-cursor — ⌥-click adds a cursor, ⌥⌘↑↓ adds one above/below, ⌥⌘D selects the next
  occurrence, ⌥-drag makes a rectangular (column) selection (Esc dismisses)
- Sort lines (asc/desc) & remove duplicates — command palette and context menu (natural
  numeric sort)
- `/` menu (Notion-style block insert) — type `/` at the start of a line (or after
  whitespace) to insert headings, lists, tables, code, math, images, links, horizontal
  rules, page breaks, TOC and more; search in Korean or English, Enter applies
- Emoji autocomplete — Korean aliases (`:기쁨`) and exact names (`:coffee`) first; inserts
  the characters without colons; handles existing closing colons and a single undo
- Input helpers — bracket pairs, wrap in markers (`$`, `` ` ``, `*`, `~`), hard line break
  (⇧⏎), page break (⇧⌘↵ — Word page break, a `\newpage` paragraph)
- Smart paste — HTML→Markdown (Word/browsers→IYAGI), URL→link, image paste, TSV→table
  (Excel/sheets)
- Clipboard edit protection — image event data saved verbatim, document and selection
  checked for delayed pastes, cut only after a successful copy
- Image drop, paste and file picker — copies into the document folder's assets/, fixes the
  insert position while typing, one undo for many images, reports partial failures
  (32 at a time, 32 MiB per file)
- Figure captions — the alt text of `![caption](image)` becomes the caption
- Table captions — a `: caption` line after the table (Pandoc convention), numbered
  'Table N' in exports
- Document comments — line-anchored sidecar + panel (edit, resolve, delete, click to jump);
  the source is untouched
- Comments in DOCX export — native Word comments (as-is in the review pane)
- Review hub — broken links (one-click create), long sentences, citations (broken-key ⚠,
  jump to bibliography) and orphan images (move to Trash — recoverable in Finder) in one place
- Folding for headings, lists, code fences and quotes (gutter ▾), fold/expand all, system
  spell check (optional)
- Code-fence language autocomplete — searches names and aliases like `py`/`js`, covers long
  fences and code blocks inside lists/quotes, replaces the existing language token while
  preserving metadata, keyword and local-variable suggestions inside blocks
- Indent guides — vertical guides for nested lists every 2 spaces (measured space width),
  excluding code fences
- Copy formatting (⌥⌘C/⌥⌘V) — paste bold/italic/code/strikethrough/highlight onto plain text;
  paragraph formats such as heading level and quotes copy too (pasting body formatting
  strips the heading marker — Word format-brush replacement semantics)
- Toolbar undo/redo & paragraph alignment — the command palette shows shortcut chips (kbd)
- Paste without formatting (⌥⌘⇧V) — plain text, no Markdown conversion
- Copy with formatting: copying a selection containing Markdown syntax also puts HTML on
  the clipboard (formatting survives in Word/mail)
- Autosave (optional) — batches input per document (tabs and split views) and saves
  atomically; turning it off cancels pending saves
- Recovery drafts — keeps unsaved content per document, restores or discards it; discarded
  drafts do not reappear on restart

**Per-document style (SQLite sidecar — source untouched)**

- 4 font families (system/serif/round/monospace), size, line height, paragraph spacing,
  alignment (incl. justified), indent, accent color
- Presets: report, blog, memo, thesis, dev notes
- Per-image sizes, per-table column widths, bookmarks
- Applied identically across the editor, HTML, PDF and DOCX

**Note system**

- Wikilinks `[[name]]` + autocomplete (list on `[[`) + backlinks panel (click '🔗 N'; covers
  regular inline and reference Markdown links too)
- Note embeds `![[name]]` — the target document's source inline as a card (click opens,
  caret reveals the source). Expanded to real content before export (HTML/PDF/EPUB/DOCX
  share the path) with depth 4 and cycle protection — unreadable targets stay verbatim
- Callouts `> [!type] title` — 13 card types from the quote's first line (note…quote, 27
  aliases normalized). Icon and type-colored cards in live preview, card styles in
  HTML/EPUB/PDF, filled table cards in DOCX. The source stays a plain quote and degrades
  harmlessly in other renderers
- Rename heading (command palette) — edits the heading at the caret and updates every
  `[[doc#anchor]]`/`[[#anchor]]` link that points at it, workspace-wide (both display and
  slug spellings; other files applied safely against on-disk expectations)
- Daily note (palette 'open today's document') — opens today's (local date) document or
  creates it (root-first search)
- Jump to `#heading` positions of document links · line jumps from search and backlink
  results · preserves later tab selection and the caret while files open asynchronously
- Navigation history — back/forward (⌥⌘←/→) across tab, link, TOC and bookmark moves,
  restores selection and reading position, compensates edit positions, per window
- Reopen closed tab (⇧⌘T) — restores the window's last 20 files from the tab bar, File menu
  and palette; re-reads the newest file and restores tab order, view mode, lock and
  selection; discarded content is not restored
- Document graph — visualizes the real connections of wiki and regular Markdown links
  (node size = link count, active document highlighted), cursor-anchored wheel zoom, drag
  pan, double-click opens, background double-click resets, keyboard navigation (←→↑↓,
  Enter, +/−/0); workspaces over 250 documents use a circular layout
- Link hover preview (wiki, internal Markdown, footnotes — render popover) · broken
  local-link check of the current text (distinguishes real images, reference links,
  unverifiable) · create missing documents · insert TOC and lists of figures/tables (lof/lot)
  · static HTML/PDF TOC (heading anchors) · document tidy (blank-line normalization +
  table alignment)
- Tags `#tag` + autocomplete (list on `#`) + click → workspace search
- Quick open (fuzzy file search from the command palette)
- Folder-wide search (⇧⌘F) — shows miss reasons, files read and result caps, refreshes after
  saves · replace all (review changes, backup, per-file diff-and-save, metadata preserved)
- Version history: 30 snapshots taken just before each save + diff preview + restore
- Comments (Word-style): line-anchored sidecar — right-click to add, hover, panel review,
  exported as native DOCX comments
- Review hub: broken links, long sentences (dotted-underline toggle), orphan-image cleanup
- File management: sidebar right-click — new document, rename, duplicate · rename previews
  wiki and Markdown (inline/reference) link updates with backup, compared application and
  review-job restart recovery
- Document compare (diff view — against another file or the on-disk version)
- Highlight `==text==` (choice of 5 colors) · YAML front matter (document info form)
- Front-matter title reflected in save file names · tab right-click 'Reveal in Finder'


**Writing mode**

- Typewriter scroll (keeps the caret line vertically centered while typing) · focus mode
  (dims everything but the current block)
- Sentence focus (crisp current sentence)
- Read aloud — system voices, rate and voice choice, reading indicator (selection or whole
  document)

**Navigation & tools**

- Command palette (⌘⇧P) — fuzzy search over every command · `@` in-document heading jump ·
  recent commands first
- TOC panel — ATX and Setext headings, scroll tracking with the current heading highlighted,
  root-section drag-move that preserves source whitespace
- TOC keyboard navigation — ↑/↓/Home/End move focus, ←/→ fold/expand and parent/child moves,
  Korean jamo search, Enter opens, Escape returns to the search box
- Heading links — anchor-collision prevention for duplicate headings and automatic
  numbering, the same duplicate-assignment rules in HTML and DOCX, DOCX styled headings and
  encoded internal links handled
- DOCX heading anchors — generated from the source before quote conversion; body headings
  assigned first, quoted headings in reference order
- Split editing (reference view) — edit a pinned document beside the current one, with
  proportional synced scrolling
- Track changes — Word Track Changes for Markdown: insertion/deletion marks, changes panel,
  status bar ✎ +N −R, per-hunk revert ('reject'), next/previous navigation, deleted blocks
  shown in the text (strikethrough), click ↺ to revert
- Document statistics (words, characters, paragraphs, tables, reading time, sentence-length
  distribution, click-to-jump long sentences) · selection stats ('3 words · 12 chars') ·
  task progress (☑ 3/7)
- Same-word highlight (occurrences of the caret word — Word standard) · reference view
  (pin a tab beside)
- Long-sentence marker (optional) — dotted underline for 60+ characters in the editor
  (writer's aid)
- Show formatting marks (settings/palette) — space ··, tab →, line end ¶ (Word formatting
  marks; exposes doubled and trailing spaces)
- Citations & bibliography — `[@key]` in the text → superscript [N] (first-appearance order)
  · `[@key]: entry` definitions (HTML links and numbering, editor tooltips and
  broken-citation marks) + `[@` autocomplete (bibliography descriptions, existing brackets
  and page notations preserved, candidates refresh)
- Citations in DOCX — citations become superscript hyperlinks to the bibliography anchor,
  bibliography paragraphs are bookmarked (click-to-jump in Word), broken citations preserved
  verbatim
- DOCX citation guard — excludes markers inside code, existing links, images and math;
  handles special-character suffixes and footnote citations; preserves jump targets of
  adjacent entries
- Citation review & preview — shared parsing avoids code-example/metadata false positives,
  prevents nested citation links in HTML, preserves image alt text
- Status-bar breadcrumb — current heading path, click to jump
- Keyboard shortcuts help (Help › Keyboard Shortcuts)
- Command palette — Enter opens even when only files match, keeps the selection while lists
  refresh, arrow/Page Up/Down navigation keeps the input focus
- Dialog keyboard support — focus moves on open, Tab cycles inside overlaid and progress
  windows, returns to the previous button/input on close
- Command routing — background-document commands blocked while a dialog has input, shortcuts
  the input handled are respected, native-menu wiring for version history, folder search,
  symbols and link checks
- Document info editing — confirms the target document and external changes, confirms draft
  discard, applies only edited fields while preserving body, line endings and other metadata
- Link & image editing — tracks target positions, blocks conflicting changes, keeps drafts
  on errors, handles special characters, preserves existing link titles and unmodified
  formatting
- Image viewer — distinguishes the source positions of duplicate images, previous/next
  navigation excluding code/math/metadata, keeps descriptions, per-image zoom/rotation reset
- Table insert — tracks the original selection, keeps input on document switch, change
  conflict or rejected apply, previews header vs body rows, multi-line selection replacement
  with individual undo
- Symbol insert — continuous inserts from the original selection, keeps search focus,
  separates search editing from result navigation, warns on document switch or failed insert
- Slash commands — Korean/English alias search with restore after clearing, excluded inside
  code/math/links, source-preserving TOC/page-break inserts with a single undo
- Wiki & tag autocomplete — distinguishes the real paths of same-named documents,
  substitutes Markdown links for special file names, preserves existing brackets/anchors/
  aliases, refreshes candidates and reflects nested-folder changes
- Find & replace — Korean word boundaries, exact Unicode positions, regex capture
  substitution, reserved searches and tab-switch handling, replace after full-count
  confirmation, protects changed documents
- Search responsiveness — regex and large-document searches computed in the background,
  cancelled on change or close, timeout notices and retries, caret position preserved while
  waiting
- Search navigation — browse results beyond the display cap with next/previous, keeping only
  the needed window with whole-document ordinals and totals, wrapping at the ends
- Print preview (⌘P) — paper, orientation, margins and scale; blocks printing before ready,
  retries errors, keyboard navigation. Reuses the confirmed HTML for PDF generation; export
  options persist across restarts
- Export keeps the window and options after cancel or failure and retries with the same
  document; on completion shows the actual saved path and Reveal in Finder; prevents
  duplicate runs and closing mid-export

**Export**

- HTML: self-contained single file (images and fonts inlined, DOMPurify)
- PDF: vector, paper size, margins, scale, page numbers (N / M)
- DOCX: Word default styles + per-document styles + OMML math + DrawingML shapes + tables +
  page numbers (optional) + page breaks (`\newpage` → Word page break)
- HTML/PDF: `\newpage` paragraphs become page breaks (dotted in the on-screen preview too)
- Multi-column layout — front matter `columns: 2` (or 3): CSS columns in HTML and print
  (h1/h2 span the columns), PDF tiling recomputes column widths, DOCX sectPr w:cols (same as
  Word Layout › Columns)
- Free-text headers/footers — front matter `header:`/`footer:`: the header replaces the
  document title, the footer joins the page number (HTML, PDF, DOCX footer1.xml — live Word
  headers/footers)
- EPUB: EPUB 3 e-book (TOC, chapters, cover, embedded images), split at top-level headings
  with round-trip links between chapter titles and footnotes
- EPUB save protection — replaces the file only after the ZIP completes, reports missing
  images and cover errors, handles special-character paths and reference-style cover images
- Export consistency — captures the text, styles, settings and comments as of the start;
  DOCX also replaces the file only after the ZIP completes
- DOCX comments — preserves multiple comments per line, attaches to headings, list items,
  table rows and code lines, keeps line positions after footnote processing
- DOCX footnotes — parser-based reference processing, preserves multi-paragraph lists and
  code, links footnotes and figures
- DOCX figures — standalone captions after paragraphs, keeps captions in lists, table cells
  and footnotes, repairs SVG/Mermaid figure structure
- DOCX image linking — prevents ID collisions across figure kinds, handles whitespace and
  special-character URLs and local images with query or fragment identifiers
- DOCX lists — preserves start numbers, per-list restarts, nested numbering and parenthesized
  delimiters; prevents duplicated numbers and checkboxes on continuation paragraphs
- HTML/PDF/EPUB bibliographies — emphasis, code, link and footnote formatting; preserves jump
  targets per adjacent entry and inside nested lists

**View & windows**

- Live preview, read (⌘E) and source (⌘/) modes — switching without conversion
- Read-mode page cards (paper feel) · full-window width (Word style)
- Source-mode split preview — source left, rendered right (the same pipeline as exports),
  proportional sync, width drag, off via palette/settings (pure source)
- Tabs (drag to reorder, new window ⤢, lock 🔒, session restore — incl. pinned references
  and folder folding) · folder sidebar (tree, file watching)
- Tab keyboard control — ←/→/Home/End then Enter/Space select, Delete confirms close,
  Shift+F10 menu and reorder, focus returns when a tab closes · the wheel scrolls the tab list
- Sidebar keyboard navigation — type-to-filter filenames, repeated-letter cycling,
  Korean-normalized search, focus recovery on deleted rows, skips disabled menu items and
  restores the row after the menu closes
- Document favorites — register/unregister from the File and tab menus, reach from the
  sidebar, start screen and palette, synced across windows, kept across restarts, follows
  renames
- Favorites reorder — arrow buttons or Option/Alt+↑/↓, position notice and focus kept after
  saving, re-confirms on concurrent changes from other windows
- New folder — create from the sidebar root button or the folder menu, name-collision and
  reserved-name notices with retry, expands the parent and moves into the new folder
- Create/duplicate document — prevents double runs, shows progress, result path and failure
  retry, prevents late completions from auto-switching while moving/editing; created files
  reopen via 'Open document'
- New-document default names follow the Korean/English setting · duplicates preserve the
  original bytes and register only completed files; on a name collision the existing file wins
- Move document to Trash — confirms the path and recovery method from the File menu, parks
  the open text in recovery drafts first, re-confirms on file changes, restores from the
  Finder Trash
- Light/dark auto (follows the system) · font size and reading column-width settings
- Orphan-image cleanup (find and delete unreferenced files in assets/)
- External change detection — conflict notice while editing, auto-reload otherwise
- Conflict resolution — keeps unsaved text in version history before reloading, saves as a
  different file, keeps recovery drafts of open text for deleted files, progress/failure/
  target-change notices
- Recent documents, unsaved confirmation, window state restore (incl. position and size)
- Close confirmation — target file list, save progress and failure retry, prevents double
  closes, detects changes during discard and restores partially deleted recovery drafts,
  re-checks documents just before the window closes
- Korean and English UI


## Architecture

```text
src/              React app (editor, panels, dialogs, export UI)
src-tauri/        Tauri shell (commands, menus, watcher, WKWebView PDF, style DB, drafts)
crates/
  md-core/        Pure Rust: Markdown model, links, search, sessions, snapshots, i18n, tree
  md-export/      Exporters: HTML, PDF, DOCX (OMML/DrawingML), EPUB, citations, svg2dml
  md-macos/       macOS platform layer (Trash integration)
```

The UI never touches files directly: every read, write, search and export goes through the
Rust core, which owns atomic saving, link resolution and byte-level preservation.

**Tech stack:** React 18 · TypeScript · CodeMirror 6 · Vite · Vitest · KaTeX · mermaid ·
highlight.js · DOMPurify · Tauri 2 · Rust 2021 (MSRV 1.89).

## Development

Requirements: Rust ≥ 1.89 (MSRV), Node 22 LTS, macOS 13.0+.

```sh
npm install
npm run tauri dev      # dev run (port 1422)
npm run test:unit      # frontend unit tests (incl. source-preservation suites)
cargo test --workspace # Rust tests (md-core · md-export)
npm run tauri build    # .app + DMG
```

`npm run tauri build` signs the bundle with the sole Developer ID Application certificate
in the login keychain and enables hardened runtime (`scripts/tauri.mjs`; falls back to
ad-hoc signing when no certificate exists — details in the script header).

Design principles live in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md); implementation
detail in [docs/architecture.md](docs/architecture.md).

### Releasing

Releases are tagged `v<version>` and published as GitHub Releases with the signed, notarized
DMG attached. The full checklist — version bump, build, notarization, `gh release create` —
is in [RELEASE.md](RELEASE.md). Tag pushes also run the protected-ref CI jobs, including the
macOS bundle build ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Performance

Targets (spec §1-2) and measured values (2026-10-12, Apple Silicon, release build):

| Metric | Target | Measured |
|---|---|---|
| Install size (.app) | ≤ 20 MB | **14 MB** (DMG 7.9 MB, binary 14.1 MB) |
| Cold start | ≤ 700 ms | process → Rust up in 0.02 s; first paint once the frontend is ready |
| Idle RSS (one window) | ≤ 120 MB | **102 MB** (incl. WKWebView) |
| Open a 0.9 MB Korean document | no perceptible stutter | opens — decorations increment per viewport chunk; suggests source mode over 1 MB |
| Heavy features | lazy loading | KaTeX · mermaid · highlight.js as separate chunks, loaded only when present |

## Documentation

| Document | Content |
|---|---|
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Structure and design principles |
| [docs/architecture.md](docs/architecture.md) | Implementation detail |
| [RELEASE.md](RELEASE.md) | Release notes for every version, and how releases are built and published |
| [README_KR.md](README_KR.md) | This README in Korean |

## Status & roadmap

**0.1.0** is the current and first public release — macOS (Apple Silicon). CI checks the
Rust core on Linux, the workspace on GitHub-hosted macOS, and builds the DMG on a
self-hosted macOS runner for protected refs.

- **CI-built releases on protected tags** — build and publish the installer from CI instead
  of the release Mac (needs the signing identity on a self-hosted runner)
- **Independent hash/signature channel** — publish build provenance or signatures that do
  not depend on the same GitHub account
- Continued editor and export polish — see [RELEASE.md](RELEASE.md)

## The name

IYAGI reads as *iyagi* — 이야기, the Korean word for story — with **AGI** hiding in plain
sight:

```text
IY AGI
   ───
```

You don't merely issue commands to AI — you talk with it, and it thinks and executes
alongside you. IYAGI Markdown belongs to the knowledge side of that family:

```text
IYAGI Terminal     → AI Coding / Agentic Engineering   (shipped — sh2orc/iyagi-term)
IYAGI Markdown     → Knowledge / Work                  (this repository)
IYAGI Agent        → Autonomous Tasks
IYAGI Studio       → Build & Orchestrate Agents
```

Sibling repositories: [iyagi-term](https://github.com/sh2orc/iyagi-term) (AI coding
terminal), [iyagi-layout](https://github.com/sh2orc/iyagi-layout) (layout engine).

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).

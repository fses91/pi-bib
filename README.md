# pi-bib

A pi extension for checking bibliography / BibTeX files against CrossRef and Semantic Scholar.

## Based on Bibtex-Verifier

This project is based on [Bibtex-Verifier](https://github.com/merfanian/Bibtex-Verifier). The original project provides a browser-based UI for uploading or pasting BibTeX and reviewing suggested metadata changes interactively.

`pi-bib` adapts the core idea for pi as a local command-line-style extension.

Improvements / differences:

- Runs directly inside pi via `/review:bib`.
- Recursively finds `.bib` files in a project folder.
- Produces a local Markdown report instead of requiring browser interaction.
- Uses `@retorquere/bibtex-parser`, the parser behind Better BibTeX for Zotero, instead of regex-based BibTeX parsing.
- Reports BibTeX parse issues alongside metadata checks.
- Keeps API lookup logic for CrossRef and Semantic Scholar.
- Uses DOI-first lookup when an entry has a `doi` field, then falls back to title lookup.
- Writes suggested BibTeX files under `pi-bib-suggested/` instead of modifying original `.bib` files.
- Applies only safe `updated` field suggestions to generated files; `needs_review`, `not_found`, and duplicates remain unchanged for manual review.
- Adds citation-review guidance to pi's system prompt so the LLM behaves like a skeptical bibliography reviewer when helping with citations.

## Install

Once published to npm:

```bash
pi install npm:pi-bib
```

For local development from this folder:

```bash
npm install
pi -e .
```

## Commands

### `/review:bib [path]`

Recursively searches for `.bib` files under `path` or the current working directory, parses them with `@retorquere/bibtex-parser`, checks entries against CrossRef and Semantic Scholar, detects duplicate titles, writes a Markdown report, and creates safe suggested BibTeX files.

Lookup order per entry:

1. If a `doi` field exists, look up the DOI directly in CrossRef and Semantic Scholar.
2. If DOI lookup fails or no DOI is present, fall back to title-based lookup.
3. Compare the found metadata with the local BibTeX entry and report field differences.

Outputs:

```txt
pi-bib-report.md
pi-bib-suggested/<same relative path as each checked .bib file>
```

The suggested files apply safe `updated` metadata suggestions only. Entries marked `needs_review`, `not_found`, or duplicate are kept unchanged so you can inspect them manually.

Ignored folders: `node_modules`, `.git`, `.pi`, `dist`, `pi-bib-suggested`.

## LLM citation-review guidance

When the extension is loaded, it appends bibliography-review instructions to pi's system prompt. The guidance tells the LLM to:

- treat citations as unverified until validated against reliable metadata
- prefer DOI-based evidence over title-only matches
- avoid inventing missing metadata
- flag suspicious author, title, year, venue, DOI, and duplicate mismatches
- treat `updated` as a safe suggestion, `needs_review` as uncertain, and `not_found` as unvalidated
- inspect `pi-bib-report.md` first for broad bibliography reviews
- avoid overwriting original `.bib` files unless explicitly asked

## Development

Typecheck:

```bash
npm run typecheck
```

Check what would be published:

```bash
npm run pack:dry
```

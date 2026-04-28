import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BibEntry, FieldDiff, StandardPaper } from "./biblib.js";
import * as B from "./biblib.js";

const CROSSREF_API = "https://api.crossref.org/works";
const SS_MATCH = "https://api.semanticscholar.org/graph/v1/paper/search/match";
const SS_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search";
const SS_PAPER = "https://api.semanticscholar.org/graph/v1/paper";
const SS_FIELDS = "title,authors,year,venue,publicationVenue,externalIds";
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1500;
const FETCH_TIMEOUT_MS = 15000;
const ENTRY_CONCURRENCY = 3;

const BIB_REVIEWER_SYSTEM_PROMPT = `
## pi-bib citation-review guidance

When working with BibTeX files, bibliographies, references, citations, or pi-bib reports, act as a skeptical citation reviewer.

Your job is to identify hallucinated, incorrect, incomplete, duplicated, or suspicious citations. Do not trust a citation merely because it is present in a paper, Markdown file, LaTeX file, BibTeX file, or user prompt.

Guidelines:
- Treat every citation as unverified until it can be validated against reliable metadata such as DOI, CrossRef, Semantic Scholar, venue, year, title, and authors.
- Prefer DOI-based evidence over title-only matches.
- If title, authors, year, venue, or DOI disagree, mark the entry as suspicious instead of silently accepting it.
- Distinguish between safe metadata corrections and cases that need human review.
- Never invent missing citation metadata. If you cannot validate a field, say so clearly.
- Watch for hallucinated papers, wrong venues, wrong years, author mismatches, duplicate entries, preprint-vs-published-version confusion, and malformed DOI fields.
- When using pi-bib output, treat \`updated\` as a suggested safe metadata improvement, \`needs_review\` as uncertain, and \`not_found\` as unvalidated.
- For broad bibliography review tasks, inspect \`pi-bib-report.md\` first and focus on the highest-risk entries instead of loading every generated BibTeX file into context.
- Do not overwrite original bibliography files unless the user explicitly asks. Prefer reviewing \`pi-bib-report.md\` and suggested files under \`pi-bib-suggested/\` first.
`;

type CheckResult = {
  file: string;
  index: number;
  entry_id: string;
  entry_type: string;
  title: string;
  status: "verified" | "updated" | "needs_review" | "not_found";
  title_score: number;
  duplicate_of: string | null;
  found_title: string;
  field_diffs: FieldDiff[];
};

type ParseIssue = { file: string; message: string };
type FileCheck = {
  results: CheckResult[];
  parseIssues: ParseIssue[];
  suggestedPath: string | null;
};

const rateState = {
  ssDelay: 500,
  crDelay: 100,
  ssMin: 300,
  ssMax: 3000,
  crMin: 50,
  crMax: 2000,
  lastSSTime: 0,
  lastCRTime: 0,
  ssConsecutiveOk: 0,
  crConsecutiveOk: 0,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rateBackoff(source: "ss" | "cr") {
  if (source === "ss") {
    rateState.ssDelay = Math.min(rateState.ssDelay * 1.3, rateState.ssMax);
    rateState.ssConsecutiveOk = 0;
  } else {
    rateState.crDelay = Math.min(rateState.crDelay * 1.3, rateState.crMax);
    rateState.crConsecutiveOk = 0;
  }
}

function rateSuccess(source: "ss" | "cr") {
  if (source === "ss") {
    rateState.ssConsecutiveOk++;
    if (rateState.ssConsecutiveOk >= 2) {
      rateState.ssDelay = Math.max(rateState.ssDelay * 0.85, rateState.ssMin);
      rateState.ssConsecutiveOk = 0;
    }
  } else {
    rateState.crConsecutiveOk++;
    if (rateState.crConsecutiveOk >= 2) {
      rateState.crDelay = Math.max(rateState.crDelay * 0.85, rateState.crMin);
      rateState.crConsecutiveOk = 0;
    }
  }
}

async function fetchJSON(
  url: string,
  params: Record<string, string>,
  options: { retries?: number; is404Ok?: boolean } = {},
) {
  const { retries = MAX_RETRIES, is404Ok = false } = options;
  const u = new URL(url);
  for (const [key, value] of Object.entries(params))
    u.searchParams.set(key, value);

  const isSS = url.includes("semanticscholar.org");
  const source = isSS ? "ss" : "cr";
  const delay = isSS ? rateState.ssDelay : rateState.crDelay;
  const lastKey = isSS ? "lastSSTime" : "lastCRTime";
  const elapsed = Date.now() - rateState[lastKey];
  if (elapsed < delay) await sleep(delay - elapsed);
  rateState[lastKey] = Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(u.toString(), {
        headers: { "user-agent": "pi-bib/0.1" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) {
        rateSuccess(source);
        return await resp.json();
      }
      if (resp.status === 404 && is404Ok) return null;
      if (resp.status === 429 && attempt < retries) {
        rateBackoff(source);
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      return null;
    } catch {
      rateBackoff(source);
      if (attempt < retries) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function searchSSMatch(title: string) {
  const data = await fetchJSON(
    SS_MATCH,
    { query: title, fields: SS_FIELDS },
    { is404Ok: true },
  );
  return data?.data?.[0] ? B.ssToStandard(data.data[0]) : null;
}

async function searchSSSearch(title: string) {
  const data = await fetchJSON(SS_SEARCH, {
    query: title,
    limit: "5",
    fields: SS_FIELDS,
  });
  return (data?.data || []).map(B.ssToStandard);
}

async function searchCrossref(title: string) {
  const data = await fetchJSON(CROSSREF_API, {
    "query.title": title,
    rows: "5",
    select:
      "title,author,published-print,published-online,container-title,volume,issue,page,DOI,publisher,URL,type",
  });
  return (data?.message?.items || []).map(B.crossrefToStandard);
}

async function lookupCrossrefDoi(doi: string) {
  const data = await fetchJSON(
    `${CROSSREF_API}/${encodeURIComponent(doi)}`,
    {},
    { is404Ok: true },
  );
  return data?.message ? B.crossrefToStandard(data.message) : null;
}

async function lookupSSDoi(doi: string) {
  const data = await fetchJSON(
    `${SS_PAPER}/DOI:${encodeURIComponent(doi)}`,
    { fields: SS_FIELDS },
    { is404Ok: true },
  );
  return data ? B.ssToStandard(data) : null;
}

async function lookupByDoi(doi: string) {
  const cleanDoi = normalizeDoi(doi);
  if (!cleanDoi) return null;

  const [crMatch, ssMatch] = await Promise.all([
    lookupCrossrefDoi(cleanDoi),
    lookupSSDoi(cleanDoi),
  ]);

  if (crMatch && ssMatch && B.isSamePaper(crMatch, ssMatch))
    return B.mergeMetadata(crMatch, ssMatch);
  return crMatch || ssMatch;
}

async function lookupPaper(entry: BibEntry) {
  const doiMatch = await lookupByDoi(entry.doi || "");
  if (doiMatch) return doiMatch;

  const title = B.stripLatex(entry.title || "");
  if (!title.trim()) return null;

  const ssMatch = await searchSSMatch(title);
  if (
    ssMatch &&
    B.titleSimilarity(title, ssMatch.title || "") >= B.MIN_TITLE_SIM
  ) {
    const crMatch = B.bestMatch(await searchCrossref(title), title);
    if (crMatch && B.isSamePaper(ssMatch, crMatch))
      return B.mergeMetadata(ssMatch, crMatch);
    return ssMatch;
  }

  const crMatch = B.bestMatch(await searchCrossref(title), title);
  if (crMatch) return crMatch;

  return B.bestMatch(await searchSSSearch(title), title);
}

function normalizeDoi(doi: string) {
  return doi
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/[.,;\s]+$/g, "")
    .toLowerCase();
}

async function findBibFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const ignored = new Set([
    "node_modules",
    ".git",
    ".pi",
    "dist",
    "pi-bib-suggested",
  ]);

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".bib"))
        out.push(full);
    }
  }

  await walk(root);
  return out.sort();
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

async function checkFile(
  file: string,
  root: string,
  onProgress?: (current: number, total: number, entryId: string) => void,
): Promise<FileCheck> {
  const content = await fs.readFile(file, "utf8");
  const parsed = B.parseBibWithErrors(content);
  const entries = parsed.entries;
  const suggestedEntries = entries.map((entry) => ({ ...entry }));
  const parseIssues = parsed.errors.map((error) => ({
    file,
    message: error.input ? `${error.error}: ${error.input}` : error.error,
  }));

  const seenTitles = new Map<string, string>();
  const duplicateOfByIndex = entries.map((entry, i) => {
    const title = entry.title || "";
    const entryId = entry.ID || `entry_${i}`;
    const norm = B.normalizeTitle(title);
    const duplicateOf = norm ? (seenTitles.get(norm) ?? null) : null;
    if (norm && !duplicateOf) seenTitles.set(norm, entryId);
    return duplicateOf;
  });
  let completed = 0;

  const results = await mapLimit(
    entries,
    ENTRY_CONCURRENCY,
    async (entry, i) => {
      const title = entry.title || "";
      const duplicateOf = duplicateOfByIndex[i];
      let result: CheckResult;

      if (!title.trim() && !entry.doi?.trim()) {
        result = buildResult(
          file,
          entry,
          i,
          "not_found",
          0,
          [],
          null,
          duplicateOf,
        );
      } else {
        const found = await lookupPaper(entry);
        if (!found) {
          result = buildResult(
            file,
            entry,
            i,
            "not_found",
            0,
            [],
            null,
            duplicateOf,
          );
        } else {
          const cmp = B.compareEntry(entry, found);
          const fieldDiffs =
            cmp.status === "needs_review"
              ? B.fieldDiffsForNeedsReview(entry, found)
              : cmp.field_diffs;
          if (cmp.status === "updated")
            applySafeSuggestions(suggestedEntries[i], fieldDiffs);
          result = buildResult(
            file,
            entry,
            i,
            cmp.status,
            cmp.title_score,
            fieldDiffs,
            found,
            duplicateOf,
          );
        }
      }

      completed++;
      onProgress?.(completed, entries.length, entry.ID || `entry_${i}`);
      return result;
    },
  );

  const suggestedPath = await writeSuggestedBib(file, root, suggestedEntries);
  return { results, parseIssues, suggestedPath };
}

function applySafeSuggestions(entry: BibEntry, fieldDiffs: FieldDiff[]) {
  for (const diff of fieldDiffs) {
    if (diff.found?.trim()) entry[diff.field] = diff.found;
  }
}

async function writeSuggestedBib(
  file: string,
  root: string,
  entries: BibEntry[],
) {
  if (!entries.length) return null;
  const relative = path.relative(root, file);
  const suggestedPath = path.join(root, "pi-bib-suggested", relative);
  await fs.mkdir(path.dirname(suggestedPath), { recursive: true });
  await fs.writeFile(suggestedPath, B.entriesToBib(entries), "utf8");
  return suggestedPath;
}

function buildResult(
  file: string,
  entry: BibEntry,
  index: number,
  status: CheckResult["status"],
  titleScore: number,
  fieldDiffs: FieldDiff[],
  found: StandardPaper | null,
  duplicateOf: string | null,
): CheckResult {
  return {
    file,
    index,
    entry_id: entry.ID || "",
    entry_type: entry.ENTRYTYPE || "",
    title: entry.title || "",
    status,
    title_score: titleScore,
    duplicate_of: duplicateOf,
    found_title: found?.title || "",
    field_diffs: fieldDiffs,
  };
}

function renderMarkdown(
  results: CheckResult[],
  parseIssues: ParseIssue[],
  suggestedFiles: string[],
  root: string,
) {
  const counts = {
    verified: 0,
    updated: 0,
    needs_review: 0,
    not_found: 0,
    duplicates: 0,
  };
  for (const result of results) {
    counts[result.status]++;
    if (result.duplicate_of) counts.duplicates++;
  }

  const lines = [
    "# pi-bib report",
    "",
    `Checked ${results.length} entries in ${new Set(results.map((r) => r.file)).size} .bib file(s).`,
    "",
    `- Verified: ${counts.verified}`,
    `- Updated / field differences: ${counts.updated}`,
    `- Needs review: ${counts.needs_review}`,
    `- Not found: ${counts.not_found}`,
    `- Duplicates: ${counts.duplicates}`,
    `- Parse issues: ${parseIssues.length}`,
    `- Suggested BibTeX files: ${suggestedFiles.length}`,
    "",
  ];

  if (suggestedFiles.length) {
    lines.push("## Suggested BibTeX files", "");
    lines.push(
      "These files apply safe `updated` suggestions only. Original `.bib` files are not modified.",
      "",
    );
    for (const file of suggestedFiles) {
      lines.push(`- \`${path.relative(root, file)}\``);
    }
    lines.push("");
  }

  if (parseIssues.length) {
    lines.push("## Parse issues", "");
    for (const issue of parseIssues) {
      lines.push(
        `- \`${path.relative(root, issue.file)}\`: ${escapeMd(issue.message)}`,
      );
    }
    lines.push("");
  }

  for (const result of results.filter(
    (r) => r.status !== "verified" || r.duplicate_of,
  )) {
    lines.push(`## ${result.entry_id || "(no id)"}`);
    lines.push(`File: \`${path.relative(root, result.file)}\``);
    lines.push(
      `Status: **${result.status}**${result.duplicate_of ? `, duplicate of **${result.duplicate_of}**` : ""}`,
    );
    lines.push(`Title: ${result.title || "(no title)"}`);
    if (result.found_title)
      lines.push(`Found: ${result.found_title} (${result.title_score}%)`);
    if (result.field_diffs.length) {
      lines.push(
        "",
        "| Field | Current | Suggested | Score |",
        "|---|---|---|---|",
      );
      for (const diff of result.field_diffs) {
        lines.push(
          `| ${escapeMd(diff.field)} | ${escapeMd(diff.original || "—")} | ${escapeMd(diff.found)} | ${diff.score ?? ""} |`,
        );
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function escapeMd(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("pi-bib loaded", "info");
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${BIB_REVIEWER_SYSTEM_PROMPT}`,
    };
  });

  pi.registerCommand("review:bib", {
    description:
      "Find .bib files and check entries against CrossRef and Semantic Scholar",
    handler: async (args, ctx) => {
      const root = path.resolve(args.trim() || process.cwd());
      ctx.ui.notify(`Searching for .bib files in ${root}`, "info");

      const files = await findBibFiles(root);
      if (!files.length) {
        ctx.ui.notify("No .bib files found", "warning");
        return;
      }

      ctx.ui.notify(
        `Found ${files.length} .bib file(s). Checking entries...`,
        "info",
      );
      ctx.ui.setWidget(
        "pi-bib-progress",
        ["pi-bib: starting bibliography review..."],
        { placement: "belowEditor" },
      );

      const allResults: CheckResult[] = [];
      const parseIssues: ParseIssue[] = [];
      const suggestedFiles: string[] = [];
      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        const file = files[fileIndex];
        const relativeFile = path.relative(root, file);
        let lastWidgetUpdate = 0;
        ctx.ui.setStatus(
          "pi-bib",
          `Checking file ${fileIndex + 1}/${files.length}: ${relativeFile}`,
        );
        const checked = await checkFile(
          file,
          root,
          (current, total, entryId) => {
            const progress = `Checking ${relativeFile}: ${current}/${total} (${entryId})`;
            ctx.ui.setStatus("pi-bib", progress);

            const now = Date.now();
            if (
              current === 1 ||
              current === total ||
              now - lastWidgetUpdate > 2000
            ) {
              lastWidgetUpdate = now;
              ctx.ui.setWidget(
                "pi-bib-progress",
                [`pi-bib: file ${fileIndex + 1}/${files.length}`, progress],
                { placement: "belowEditor" },
              );
            }
          },
        );
        allResults.push(...checked.results);
        parseIssues.push(...checked.parseIssues);
        if (checked.suggestedPath) suggestedFiles.push(checked.suggestedPath);
      }

      const reportPath = path.join(root, "pi-bib-report.md");
      await fs.writeFile(
        reportPath,
        renderMarkdown(allResults, parseIssues, suggestedFiles, root),
        "utf8",
      );
      ctx.ui.setStatus("pi-bib", "");
      ctx.ui.setWidget("pi-bib-progress", undefined);
      ctx.ui.notify(
        `pi-bib checked ${allResults.length} entries. Report: ${path.relative(root, reportPath)}`,
        "info",
      );
    },
  });
}

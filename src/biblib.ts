import { type Creator, type Library, parse } from "@retorquere/bibtex-parser";

export type BibEntry = Record<string, string> & {
  ENTRYTYPE?: string;
  ID?: string;
};
export type ParseIssue = { error: string; input?: string };
export type ParsedBib = { entries: BibEntry[]; errors: ParseIssue[] };
export type StandardPaper = Record<string, string | undefined> & {
  title?: string;
  _source?: string;
};
export type FieldDiff = {
  field: string;
  original: string;
  found: string;
  score?: number;
};

export const TITLE_MATCH_THRESHOLD = 85;
export const MIN_TITLE_SIM = 70;
export const COMPARED_FIELDS = [
  "author",
  "year",
  "journal",
  "booktitle",
  "volume",
  "number",
  "pages",
  "doi",
  "publisher",
];

const LATEX_ACCENT_MAP: Record<string, string> = {
  "\\'a": "á",
  "\\'e": "é",
  "\\'i": "í",
  "\\'o": "ó",
  "\\'u": "ú",
  "\\`a": "à",
  "\\`e": "è",
  "\\`i": "ì",
  "\\`o": "ò",
  "\\`u": "ù",
  '\\"a': "ä",
  '\\"e': "ë",
  '\\"i': "ï",
  '\\"o': "ö",
  '\\"u': "ü",
  "\\~n": "ñ",
  "\\~a": "ã",
  "\\~o": "õ",
  "\\^a": "â",
  "\\^e": "ê",
  "\\^i": "î",
  "\\^o": "ô",
  "\\^u": "û",
  "\\c{c}": "ç",
  "\\c c": "ç",
  "{\\ss}": "ß",
};

export function stripLatex(text = "") {
  for (const [latex, ch] of Object.entries(LATEX_ACCENT_MAP))
    text = text.replaceAll(latex, ch);
  return text
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(title = "") {
  return stripLatex(title).toLowerCase().trim();
}

function creatorToString(creator: Creator) {
  if (creator.name) return creator.name;
  const last = creator.lastName || "";
  const first = creator.firstName || "";
  return last ? `${last}, ${first}`.replace(/, $/, "") : first;
}

function fieldValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object")
          return creatorToString(item as Creator);
        return "";
      })
      .filter(Boolean)
      .join(" and ");
  }
  return "";
}

function libraryToEntries(library: Library): BibEntry[] {
  return library.entries.map((parsedEntry) => {
    const entry: BibEntry = {
      ENTRYTYPE: parsedEntry.type.toLowerCase(),
      ID: parsedEntry.key,
    };

    for (const [field, value] of Object.entries(parsedEntry.fields)) {
      entry[field.toLowerCase()] = fieldValueToString(value);
    }

    return entry;
  });
}

export function parseBibWithErrors(content: string): ParsedBib {
  const library = parse(content, { unsupported: "ignore" });
  return {
    entries: libraryToEntries(library),
    errors: library.errors.map((error) => ({
      error: error.error,
      input: error.input,
    })),
  };
}

export function parseBib(content: string): BibEntry[] {
  return parseBibWithErrors(content).entries;
}

export function entriesToBib(entries: BibEntry[]) {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`@${entry.ENTRYTYPE || "misc"}{${entry.ID || "unknown"},`);
    for (const [k, v] of Object.entries(entry)) {
      if (k === "ENTRYTYPE" || k === "ID" || k.startsWith("_")) continue;
      lines.push(`  ${k} = {${v}},`);
    }
    lines.push("}\n");
  }
  return lines.join("\n");
}

const TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "based",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function comparableTokens(text: string) {
  return normalizeText(stripLatex(text))
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !TOKEN_STOP_WORDS.has(token));
}

export function tokenSortRatio(a = "", b = "") {
  const normalizedA = normalizeText(stripLatex(a));
  const normalizedB = normalizeText(stripLatex(b));
  if (normalizedA === normalizedB) return 100;

  const aTokens = comparableTokens(normalizedA);
  const bTokens = comparableTokens(normalizedB);
  if (!aTokens.length && !bTokens.length) return 100;
  if (!aTokens.length || !bTokens.length) return 0;

  const remaining = new Map<string, number>();
  for (const token of bTokens) {
    remaining.set(token, (remaining.get(token) || 0) + 1);
  }

  let intersection = 0;
  for (const token of aTokens) {
    const count = remaining.get(token) || 0;
    if (count <= 0) continue;
    intersection++;
    if (count === 1) remaining.delete(token);
    else remaining.set(token, count - 1);
  }

  return Math.round(
    (2 * intersection * 100) / (aTokens.length + bTokens.length),
  );
}

export function titleSimilarity(a = "", b = "") {
  return tokenSortRatio(a.toLowerCase().trim(), b.toLowerCase().trim());
}

export function normalizeText(text = "") {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeAuthorSet(authorStr = "") {
  const norm = normalizeText(authorStr);
  const names = new Set<string>();
  for (let a of norm.split(/\s+and\s+/)) {
    a = a.trim();
    if (!a) continue;
    if (a.includes(",")) names.add(a.split(",")[0].trim());
    else {
      const t = a.split(/\s+/);
      names.add(t[t.length - 1]);
    }
  }
  return names;
}

export function normalizePages(p = "") {
  return p.trim().replace(/\s*-+\s*/g, "-");
}

export function compareAuthors(a: string, b: string) {
  const sa = normalizeAuthorSet(a),
    sb = normalizeAuthorSet(b);
  if (!sa.size && !sb.size) return 100;
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const n of sa) if (sb.has(n)) inter++;
  return (inter / Math.max(sa.size, sb.size)) * 100;
}

export function compareField(field: string, a: string, b: string) {
  const na = normalizeText(a),
    nb = normalizeText(b);
  if (!na && !nb) return 100;
  if (!na || !nb) return 0;
  if (field === "year" || field === "doi") return na === nb ? 100 : 0;
  if (field === "author") return compareAuthors(a, b);
  if (field === "pages")
    return normalizePages(na) === normalizePages(nb)
      ? 100
      : tokenSortRatio(na, nb);
  return tokenSortRatio(na, nb);
}

export function compareEntry(original: BibEntry, found: StandardPaper) {
  const titleScore = tokenSortRatio(
    normalizeTitle(original.title || ""),
    normalizeTitle(found.title || ""),
  );
  if (titleScore < TITLE_MATCH_THRESHOLD) {
    return {
      status: "needs_review" as const,
      title_score: titleScore,
      field_diffs: [] as FieldDiff[],
      suggested: found,
    };
  }

  if (original.booktitle && !original.journal && found.journal)
    found.booktitle = found.journal;
  const fieldDiffs: FieldDiff[] = [],
    enrichments: FieldDiff[] = [];
  let hasDifference = false;

  for (const field of COMPARED_FIELDS) {
    const origVal = original[field] || "";
    const foundVal = found[field] || "";
    if (!origVal && !foundVal) continue;
    if (!origVal.trim() && foundVal.trim()) {
      enrichments.push({ field, original: origVal, found: foundVal, score: 0 });
      continue;
    }
    if (origVal.trim() && !foundVal.trim()) continue;
    const score = compareField(field, origVal, foundVal);
    if (score < 100) {
      hasDifference = true;
      fieldDiffs.push({
        field,
        original: origVal,
        found: foundVal,
        score: Math.round(score * 10) / 10,
      });
    }
  }

  const allDiffs = fieldDiffs.concat(enrichments);
  const suggested: Record<string, string> = {};
  if (hasDifference || enrichments.length)
    for (const d of allDiffs) if (d.found) suggested[d.field] = d.found;
  return {
    status: hasDifference ? ("updated" as const) : ("verified" as const),
    title_score: Math.round(titleScore * 10) / 10,
    field_diffs: allDiffs,
    suggested,
  };
}

export function fieldDiffsForNeedsReview(
  original: BibEntry,
  found: StandardPaper | null,
) {
  if (!found) return [];
  const merged = { ...found };
  if (original.booktitle && !original.journal && merged.journal)
    merged.booktitle = merged.journal;
  const fieldDiffs: FieldDiff[] = [];
  const titleScore = tokenSortRatio(
    normalizeTitle(original.title || ""),
    normalizeTitle(merged.title || ""),
  );
  if ((original.title || "").trim() || (merged.title || "").trim()) {
    fieldDiffs.push({
      field: "title",
      original: original.title || "",
      found: merged.title || "",
      score: Math.round(titleScore * 10) / 10,
    });
  }
  for (const field of COMPARED_FIELDS) {
    const origVal = original[field] || "";
    const foundVal = merged[field] || "";
    if (!origVal && !foundVal) continue;
    if (origVal.trim() && !foundVal.trim()) continue;
    const score =
      !origVal.trim() && foundVal.trim()
        ? 0
        : compareField(field, origVal, foundVal);
    if (!origVal.trim() || score < 100)
      fieldDiffs.push({
        field,
        original: origVal,
        found: foundVal,
        score: Math.round(score * 10) / 10,
      });
  }
  return fieldDiffs;
}

type CrossrefAuthor = {
  family?: string;
  given?: string;
};

type CrossrefDate = {
  "date-parts"?: number[][];
};

type CrossrefItem = {
  author?: CrossrefAuthor[];
  title?: string[];
  "published-print"?: CrossrefDate;
  "published-online"?: CrossrefDate;
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  publisher?: string;
  URL?: string;
};

type SemanticScholarAuthor = {
  name?: string;
};

type SemanticScholarPaper = {
  title?: string;
  authors?: SemanticScholarAuthor[];
  year?: string | number;
  venue?: string;
  publicationVenue?: { name?: string } | null;
  externalIds?: {
    DOI?: string;
  };
};

export function crossrefToStandard(item: CrossrefItem): StandardPaper {
  const authors = (item.author || [])
    .map((a) => {
      const f = a.family || "",
        g = a.given || "";
      return f ? `${f}, ${g}`.replace(/, $/, "") : "";
    })
    .filter(Boolean);
  const dp = item["published-print"] || item["published-online"] || {};
  const container = item["container-title"] || [];
  return {
    title: (item.title || [""])[0],
    author: authors.join(" and "),
    year: dp["date-parts"]?.[0]?.[0]?.toString() || "",
    journal: container[0] || "",
    volume: item.volume || "",
    number: item.issue || "",
    pages: item.page || "",
    doi: item.DOI || "",
    publisher: item.publisher || "",
    url: item.URL || "",
    _source: "crossref",
  };
}

export function ssToStandard(paper: SemanticScholarPaper): StandardPaper {
  const authors = (paper.authors || [])
    .map((a) => {
      const name = a.name || "";
      const parts = name.split(/\s+/);
      return parts.length >= 2
        ? `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`
        : name;
    })
    .filter(Boolean);
  const ext = paper.externalIds || {};
  const venue =
    (paper.publicationVenue && typeof paper.publicationVenue === "object"
      ? paper.publicationVenue.name
      : null) ||
    paper.venue ||
    "";
  return {
    title: paper.title || "",
    author: authors.join(" and "),
    year: (paper.year || "").toString(),
    journal: venue,
    volume: "",
    number: "",
    pages: "",
    doi: ext.DOI || "",
    publisher: "",
    url: ext.DOI ? `https://doi.org/${ext.DOI}` : "",
    _source: "semantic_scholar",
  };
}

export function extractLastNames(authorStr = "") {
  const names = new Set<string>();
  for (let part of authorStr.split(/\s+and\s+/i)) {
    part = part.trim();
    if (!part) continue;
    if (part.includes(",")) names.add(part.split(",")[0].trim().toLowerCase());
    else {
      const t = part.split(/\s+/);
      names.add(t[t.length - 1].toLowerCase());
    }
  }
  return names;
}

export function isSamePaper(a: StandardPaper, b: StandardPaper) {
  if (titleSimilarity(a.title || "", b.title || "") < 85) return false;
  if (a.year && b.year && a.year !== b.year) return false;
  const aa = extractLastNames(a.author),
    ba = extractLastNames(b.author);
  if (aa.size && ba.size) {
    let inter = 0;
    for (const n of aa) if (ba.has(n)) inter++;
    if (inter / Math.max(aa.size, ba.size) < 0.3) return false;
  }
  return true;
}

export function mergeMetadata(
  primary: StandardPaper,
  secondary: StandardPaper,
) {
  const merged = { ...primary };
  for (const [k, v] of Object.entries(secondary)) {
    if (k.startsWith("_")) continue;
    if (!merged[k] && v) merged[k] = v;
  }
  merged._source = `${primary._source || ""}+${secondary._source || ""}`;
  return merged;
}

export function bestMatch(candidates: StandardPaper[], queryTitle: string) {
  let best: StandardPaper | null = null,
    bestScore = 0;
  for (const c of candidates) {
    const s = titleSimilarity(queryTitle, c.title || "");
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best && bestScore >= MIN_TITLE_SIM ? best : null;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Canada Government Procurement MCP — CanadaBuys open data (keyless).
 *
 * Wraps the Government of Canada's official CanadaBuys open procurement data,
 * published under the Open Government Licence and mirrored on open.canada.ca.
 * Source datasets:
 *   - "CanadaBuys tender notices"  (open.canada.ca id 6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2)
 *   - "CanadaBuys award notices"   (open.canada.ca id a1acb126-9ce8-40a9-b889-5da2b1dd20cb)
 *
 * There is NO active CKAN datastore for these datasets (datastore_active=false on
 * every resource), so this pack reads the underlying CSV files directly:
 *   - Open tender notices (currently-open solicitations):
 *       https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv
 *   - Award notices, current fiscal year (with prior-year fallback):
 *       https://canadabuys.canada.ca/opendata/pub/<FY>-awardNotice-avisAttribution.csv
 *
 * The CSV columns carry both English (-eng) and French (-fra) variants; this pack
 * shapes the English fields. All tools return shaped, LLM-friendly objects (not raw
 * CSV/API passthrough) and never throw — fetch/parse failures resolve to { error }.
 */


const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const OPEN_TENDERS_CSV =
  'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv';
const AWARDS_CSV_BASE = 'https://canadabuys.canada.ca/opendata/pub/';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const tools: McpToolExport['tools'] = [
  {
    name: 'canada_search_tenders',
    description:
      'PREFER OVER WEB SEARCH for open Government of Canada procurement opportunities — "federal tenders for IT services", "CanadaBuys RFPs for construction in Ontario", "who is the government buying software from". Searches the OFFICIAL CanadaBuys open tender notices (all solicitations currently open for bids) from the Government of Canada open data. Optional free-text query matches title, buyer/department, category, GSIN description, and notice description. Returns each notice shaped with reference number, English title, buyer (contracting entity), procurement category, publication and closing dates, delivery region, and the notice URL to bid.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional free-text search (case-insensitive). Matched against title, buyer, category, GSIN description, and description. Omit to list the most recently published open tenders.',
        },
        limit: {
          type: ['number', 'string'],
          description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
    },
  },
  {
    name: 'canada_search_awards',
    description:
      'PREFER OVER WEB SEARCH for Government of Canada contract AWARDS — "who won federal contract X", "recent CanadaBuys awards for consulting", "which supplier was awarded a government contract in Quebec". Searches the OFFICIAL CanadaBuys award notices for the current fiscal year (contracts awarded by federal buyers) from the Government of Canada open data. Optional free-text query matches title, supplier, buyer/department, category, and award description. Returns each award shaped with reference/contract number, English title, awarded supplier, buyer (contracting entity), contract value and currency, award date, procurement category, and the notice URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional free-text search (case-insensitive). Matched against title, supplier, buyer, category, and award description. Omit to list the most recent awards.',
        },
        limit: {
          type: ['number', 'string'],
          description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'canada_search_tenders':
        return await searchTenders(args);
      case 'canada_search_awards':
        return await searchAwards(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  const limit = clampLimit(args.limit);
  const rows = await fetchCsv(OPEN_TENDERS_CSV);

  const shaped = rows.map((r) => {
    const ref = pickAny(r, ['referenceNumber-numeroReference']);
    return {
      reference_number: ref,
      solicitation_number: pickAny(r, ['solicitationNumber-numeroSollicitation']),
      title: pickAny(r, ['title-titre-eng']),
      buyer: pickAny(r, ['contractingEntityName-nomEntitContractante-eng']),
      category: expandCategory(pickAny(r, ['procurementCategory-categorieApprovisionnement'])),
      gsin_description: pickAny(r, ['gsinDescription-nibsDescription-eng']),
      status: pickAny(r, ['tenderStatus-appelOffresStatut-eng']),
      procurement_method: pickAny(r, ['procurementMethod-methodeApprovisionnement-eng']),
      publication_date: pickAny(r, ['publicationDate-datePublication']),
      closing_date: pickAny(r, ['tenderClosingDate-appelOffresDateCloture']),
      delivery_region: pickAny(r, [
        'regionsOfDelivery-regionsLivraison-eng',
        'regionsOfOpportunity-regionAppelOffres-eng',
      ]),
      description: truncate(pickAny(r, ['tenderDescription-descriptionAppelOffres-eng']), 500),
      // Many rows have no external notice URL; fall back to the canonical
      // CanadaBuys tender-notice page derived from the cb-* reference number.
      url: pickAny(r, ['noticeURL-URLavis-eng']) ?? tenderPageUrl(ref),
    };
  });

  const filtered = query
    ? shaped.filter((s) =>
        matches(query, [s.title, s.buyer, s.category, s.gsin_description, s.description]),
      )
    : shaped;

  sortByDateDesc(filtered, 'publication_date');
  const results = filtered.slice(0, limit);

  return {
    source: 'CanadaBuys open tender notices (open.canada.ca / canadabuys.canada.ca open data)',
    query: query ?? null,
    total_open_tenders: shaped.length,
    matched: filtered.length,
    count: results.length,
    tenders: results,
  };
}

async function searchAwards(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  const limit = clampLimit(args.limit);

  const { rows, fiscalYear } = await fetchAwardsCsv();

  const shaped = rows.map((r) => ({
    reference_number: pickAny(r, ['referenceNumber-numeroReference']),
    contract_number: pickAny(r, ['contractNumber-numeroContrat']),
    solicitation_number: pickAny(r, ['solicitationNumber-numeroSollicitation']),
    title: pickAny(r, ['title-titre-eng']),
    supplier: pickAny(r, ['supplierLegalName-nomLegalFournisseur-eng']),
    supplier_location: joinNonEmpty([
      pickAny(r, ['supplierAddressCity-fournisseurAdresseVille-eng']),
      pickAny(r, ['supplierAddressProvince-fournisseurAdresseProvince-eng']),
    ]),
    buyer: pickAny(r, ['contractingEntityName-nomEntitContractante-eng']),
    contract_value: pickAny(r, [
      'totalContractValue-valeurTotaleContrat',
      'contractAmount-montantContrat',
    ]),
    currency: pickAny(r, ['contractCurrency-contratMonnaie']),
    category: expandCategory(pickAny(r, ['procurementCategory-categorieApprovisionnement'])),
    procurement_method: pickAny(r, ['procurementMethod-methodeApprovisionnement-eng']),
    award_date: pickAny(r, ['contractAwardDate-dateAttributionContrat']),
    publication_date: pickAny(r, ['publicationDate-datePublication']),
    status: pickAny(r, ['awardStatus-attributionStatut-eng']),
    description: truncate(pickAny(r, ['awardDescription-descriptionAttribution-eng']), 500),
  }));

  const filtered = query
    ? shaped.filter((s) =>
        matches(query, [s.title, s.supplier, s.buyer, s.category, s.description]),
      )
    : shaped;

  sortByDateDesc(filtered, 'award_date');
  const results = filtered.slice(0, limit);

  return {
    source: `CanadaBuys award notices, fiscal year ${fiscalYear} (open.canada.ca / canadabuys.canada.ca open data)`,
    query: query ?? null,
    fiscal_year: fiscalYear,
    total_awards: shaped.length,
    matched: filtered.length,
    count: results.length,
    awards: results,
  };
}

// Award CSVs are split per fiscal year (Apr 1 – Mar 31). Try the current FY file,
// then the previous FY as a fallback (e.g. early April when the new file is thin/absent).
async function fetchAwardsCsv(): Promise<{ rows: CsvRow[]; fiscalYear: string }> {
  const candidates = fiscalYearCandidates();
  let lastErr: unknown;
  for (const fy of candidates) {
    const url = `${AWARDS_CSV_BASE}${fy}-awardNotice-avisAttribution.csv`;
    try {
      const rows = await fetchCsv(url);
      if (rows.length) return { rows, fiscalYear: fy };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Could not load CanadaBuys award notices for ${candidates.join(' or ')}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// Canadian federal fiscal year runs Apr 1 → Mar 31, labelled "YYYY-YYYY".
function fiscalYearCandidates(): string[] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0=Jan
  const startYear = m >= 3 ? y : y - 1; // April (m=3) starts a new FY
  const cur = `${startYear}-${startYear + 1}`;
  const prev = `${startYear - 1}-${startYear}`;
  return [cur, prev];
}

// ---- CSV fetch + parse ----------------------------------------------------

type CsvRow = Record<string, string>;

async function fetchCsv(url: string): Promise<CsvRow[]> {
  const res = await fetch(url, {
    headers: { Accept: 'text/csv', 'User-Agent': UA },
  });
  if (!res.ok) {
    const body = await res
      .text()
      .then((t) => t.slice(0, 200))
      .catch(() => '');
    throw new Error(`CanadaBuys open data: ${res.status} ${body}`.trim());
  }
  const text = await res.text();
  return parseCsv(text);
}

// Minimal RFC-4180 CSV parser: handles quoted fields, escaped quotes ("") and
// embedded newlines. Strips a UTF-8 BOM. Returns objects keyed by header.
function parseCsv(text: string): CsvRow[] {
  const records = parseRecords(text);
  if (!records.length) return [];
  const header = records[0].map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h));
  const rows: CsvRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    if (rec.length === 1 && rec[0] === '') continue; // skip blank trailing line
    const row: CsvRow = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = rec[c] ?? '';
    rows.push(row);
  }
  return rows;
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // consume \r\n as a single break
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += ch;
    }
  }
  // flush trailing field/record if the file doesn't end in a newline
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}

// ---- shaping helpers ------------------------------------------------------

function pickAny(row: CsvRow, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

const CATEGORY_MAP: Record<string, string> = {
  GD: 'Goods',
  SRV: 'Services',
  CNST: 'Construction',
  SRVTGD: 'Services related to goods',
};

// CanadaBuys-native references start with "cb-" and resolve to a public page.
function tenderPageUrl(ref: string | null): string | null {
  if (ref && /^cb-/i.test(ref)) {
    return `https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/${encodeURIComponent(
      ref,
    )}`;
  }
  return null;
}

function expandCategory(raw: string | null): string | null {
  if (!raw) return null;
  const code = raw.replace(/^\*/, '').toUpperCase();
  return CATEGORY_MAP[code] ?? raw;
}

function joinNonEmpty(parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return kept.length ? kept.join(', ') : null;
}

function truncate(v: string | null, max: number): string | null {
  if (!v) return v;
  return v.length > max ? `${v.slice(0, max).trimEnd()}…` : v;
}

function matches(query: string, fields: (string | null)[]): boolean {
  const q = query.toLowerCase();
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
}

function sortByDateDesc<T extends Record<string, unknown>>(arr: T[], key: string): void {
  arr.sort((a, b) => {
    const av = String(a[key] ?? '');
    const bv = String(b[key] ?? '');
    return bv.localeCompare(av); // ISO dates sort lexicographically
  });
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  return undefined;
}

function clampLimit(v: unknown): number {
  let n: number | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Number(v);
  if (n === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

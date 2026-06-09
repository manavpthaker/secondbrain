import type { ToolDef } from './index.js';

// Canairy early-warning system (FastAPI). Default to the local service.
// Override with CANAIRY_API_URL (e.g. https://canairy-api.onrender.com/api/v1).
const CANAIRY_URL = (process.env.CANAIRY_API_URL || 'http://localhost:5555/api/v1').replace(/\/$/, '');

// Live collectors are slow (~10-15s for a full sweep), so give it room.
const FETCH_TIMEOUT_MS = 60_000;

// Canonical TIGHTEN-UP actions (mirrors canairy's src/notifications/alert_manager.py).
const TIGHTEN_UP_ACTIONS = [
  'Top off fuel & cash reserves',
  'Charge all power banks and devices',
  'Conduct family group briefing',
  'Review trusted OSINT information feeds',
];

interface RawIndicator {
  id: string;
  name: string;
  domain: string;
  status: { level: string; value: unknown; trend?: string; lastUpdate?: string; dataSource?: string };
  thresholds?: Record<string, unknown>;
  critical?: boolean;
}

export interface CanairyIndicator {
  id: string;
  name: string;
  domain: string;
  level: string; // green | amber | red | unknown
  value: unknown;
  amberThreshold?: number;
  redThreshold?: number;
  unit?: string;
  critical: boolean;
  mock: boolean;
}

export interface CanairyWarnings {
  ok: boolean;
  error?: string;
  counts: { red: number; amber: number; green: number; unknown: number };
  tightenUp: boolean; // >= 2 red, canairy's highest-priority condition
  red: CanairyIndicator[];
  amber: CanairyIndicator[];
  indicators: CanairyIndicator[];
  actions: string[];
  timestamp: string;
}

function originOf(apiUrl: string): string {
  // CANAIRY_URL ends in /api/v1; /health lives at the server root.
  return apiUrl.replace(/\/api\/v\d+$/, '');
}

async function canairyFetch(path: string): Promise<unknown> {
  const res = await fetch(`${CANAIRY_URL}${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Canairy API ${res.status}: ${await res.text()}`);
  return res.json();
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && !Number.isNaN(n) ? n : undefined;
}

function normalize(raw: RawIndicator): CanairyIndicator {
  const t = raw.thresholds || {};
  const sourceStr = `${(t.source ?? '')} ${(t.note ?? '')} ${(raw.status?.dataSource ?? '')}`.toLowerCase();
  return {
    id: raw.id,
    name: raw.name || raw.id,
    domain: raw.domain || 'other',
    level: raw.status?.level || 'unknown',
    value: raw.status?.value,
    amberThreshold: num(t.threshold_amber ?? t.amber),
    redThreshold: num(t.threshold_red ?? t.red),
    unit: typeof t.unit === 'string' ? t.unit : undefined,
    critical: Boolean(raw.critical),
    mock: sourceStr.includes('mock'),
  };
}

/**
 * Fetch the current indicator readings and derive warning state.
 * Shared by both the agent tool and the scheduled proactive push.
 * TIGHTEN-UP = >= 2 indicators at RED (canairy's threat_analyzer.check_tighten_up).
 */
export async function getCanairyWarnings(): Promise<CanairyWarnings> {
  const empty = { red: 0, amber: 0, green: 0, unknown: 0 };
  try {
    const data = (await canairyFetch('/indicators/')) as { indicators?: RawIndicator[]; timestamp?: string };
    const indicators = (data.indicators || []).map(normalize);
    const counts = { ...empty };
    for (const i of indicators) {
      if (i.level === 'red') counts.red++;
      else if (i.level === 'amber') counts.amber++;
      else if (i.level === 'green') counts.green++;
      else counts.unknown++;
    }
    return {
      ok: true,
      counts,
      tightenUp: counts.red >= 2,
      red: indicators.filter((i) => i.level === 'red'),
      amber: indicators.filter((i) => i.level === 'amber'),
      indicators,
      actions: TIGHTEN_UP_ACTIONS,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const down = msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('timed out') || msg.includes('aborted');
    return {
      ok: false,
      error: down
        ? `Canairy isn't reachable at ${CANAIRY_URL}. Start it with: launchctl load ~/Library/LaunchAgents/com.canairy.api.plist (or set CANAIRY_API_URL).`
        : `Canairy error: ${msg}`,
      counts: { ...empty },
      tightenUp: false,
      red: [],
      amber: [],
      indicators: [],
      actions: TIGHTEN_UP_ACTIONS,
      timestamp: new Date().toISOString(),
    };
  }
}

function fmtIndicator(i: CanairyIndicator): string {
  const thr = i.redThreshold !== undefined ? ` (red≥${i.redThreshold}${i.unit ? ' ' + i.unit : ''})` : '';
  const tags = [i.critical ? 'critical' : '', i.mock ? 'mock data' : ''].filter(Boolean).join(', ');
  return `  • ${i.name} [${i.domain}]: ${String(i.value)}${thr}${tags ? ` — ${tags}` : ''}`;
}

/** Human-readable full snapshot — answers "what's canairy saying?". */
export function formatStatus(w: CanairyWarnings): string {
  if (!w.ok) return w.error || 'Canairy unavailable.';
  const { counts } = w;
  const lines: string[] = [];
  lines.push(
    `🐦 Canairy: ${counts.red} red / ${counts.amber} amber / ${counts.green} green${counts.unknown ? ` / ${counts.unknown} unknown` : ''} (${w.indicators.length} indicators)`,
  );
  if (w.tightenUp) {
    lines.push('', `⚠️ TIGHTEN-UP ACTIVE — ${counts.red} indicators RED. Recommended actions:`);
    for (const a of w.actions) lines.push(`  → ${a}`);
  }
  if (w.red.length) {
    lines.push('', 'RED:');
    for (const i of w.red) lines.push(fmtIndicator(i));
  }
  if (w.amber.length) {
    lines.push('', 'AMBER:');
    for (const i of w.amber) lines.push(fmtIndicator(i));
  }
  if (!w.red.length && !w.amber.length) lines.push('All clear — every indicator green.');
  if (w.indicators.some((i) => i.mock)) {
    lines.push('', 'Note: some indicators are on mock data (set FRED_API_KEY in canairy/.env for full live data).');
  }
  return lines.join('\n');
}

/** Concise proactive alert text for a TIGHTEN-UP push. */
export function formatTightenUpAlert(w: CanairyWarnings): string {
  const reds = w.red
    .map((i) => `${i.name} ${String(i.value)}${i.redThreshold !== undefined ? `/red≥${i.redThreshold}` : ''}`)
    .join(', ');
  const lines = [
    `🐦🚨 CANAIRY TIGHTEN-UP: ${w.counts.red} indicators RED`,
    reds ? `RED: ${reds}` : '',
    '',
    'Recommended:',
    ...w.actions.map((a) => `→ ${a}`),
    '',
    'Reply "canairy status" for the full picture.',
  ].filter((l) => l !== '');
  return lines.join('\n');
}

export async function checkCanairyHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${originOf(CANAIRY_URL)}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      console.log(`[Canairy] healthy at ${CANAIRY_URL}`);
      return true;
    }
    console.warn(`[Canairy] ${CANAIRY_URL} health responded ${res.status}`);
    return false;
  } catch {
    console.warn(`[Canairy] unreachable at ${CANAIRY_URL} (set CANAIRY_API_URL to override default)`);
    return false;
  }
}

export const canairyTools: ToolDef[] = [
  {
    definition: {
      name: 'canairy_status',
      description:
        "Get the current snapshot from Canairy, the early-warning system that monitors ~27 global risk indicators (financial, supply-chain, geopolitical, AI, infrastructure). Returns every RED and AMBER indicator with its value and threshold, the red/amber/green counts, and whether the critical TIGHTEN-UP condition (2+ reds) is active. Use this whenever the user asks what canairy is saying, the current risk level, or whether there are any warnings.",
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    handler: async () => {
      const w = await getCanairyWarnings();
      return formatStatus(w);
    },
  },
  {
    definition: {
      name: 'canairy_indicator',
      description:
        "Get the current detail for one specific Canairy indicator by id (e.g. 'Treasury', 'ICEDetention', 'TaiwanZone', 'CISACyber', 'AGIMilestones', 'GDPGrowth'). Use when the user asks about a single indicator. If unsure of the exact id, call canairy_status first to see the available indicators.",
      input_schema: {
        type: 'object' as const,
        properties: {
          indicator_id: { type: 'string', description: 'Indicator id, e.g. Treasury or ICEDetention (case-sensitive).' },
        },
        required: ['indicator_id'],
      },
    },
    handler: async (input) => {
      const id = String(input.indicator_id || '').trim();
      if (!id) return 'Provide an indicator_id (e.g. Treasury).';
      try {
        const raw = (await canairyFetch(`/indicators/${encodeURIComponent(id)}`)) as RawIndicator;
        const i = normalize(raw);
        const parts = [
          `🐦 ${i.name} (${i.id}) [${i.domain}]: ${i.level.toUpperCase()}`,
          `value: ${String(i.value)}${i.unit ? ' ' + i.unit : ''}`,
          i.amberThreshold !== undefined ? `amber≥${i.amberThreshold}` : '',
          i.redThreshold !== undefined ? `red≥${i.redThreshold}` : '',
          i.critical ? 'flagged critical' : '',
          i.mock ? 'mock data (no live API key)' : '',
        ].filter(Boolean);
        return parts.join(' | ');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404')) return `No canairy indicator with id "${id}". Call canairy_status to list valid ids.`;
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('aborted'))
          return `Canairy isn't reachable at ${CANAIRY_URL}. Start it: launchctl load ~/Library/LaunchAgents/com.canairy.api.plist`;
        return `Canairy error: ${msg}`;
      }
    },
  },
];

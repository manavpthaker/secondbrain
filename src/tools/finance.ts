import type { ToolDef } from './index.js';

const BMM_URL = process.env.BMM_API_URL || 'http://localhost:8080';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USER_ID = process.env.BMM_USER_ID || '';

async function bmmFetch(path: string, options?: RequestInit): Promise<string> {
  try {
    const res = await fetch(`${BMM_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
    if (!res.ok) return `BMM API error (${res.status}): ${await res.text()}`;
    return JSON.stringify(await res.json(), null, 2);
  } catch (err) {
    if (err instanceof Error && err.message.includes('ECONNREFUSED')) {
      return 'Brown Man Money server is not running. Start it with: cd ~/Documents/GitHub/brown-man-money && npm start';
    }
    return `Finance API error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function sb(path: string): Promise<any> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured in brownbot .env');
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

function requireUser(): string {
  if (!USER_ID) throw new Error('BMM_USER_ID not set in brownbot .env');
  return USER_ID;
}

// Deterministic Plaid → finance-DB pull, callable from schedulers without an LLM.
// The read tools (get_account_balances etc.) only ever read the finance DB, so
// something has to drive this on a schedule or the numbers go stale. Returns the
// raw BMM response string (or an error string) for logging — never throws.
export async function syncPlaidTransactions(days = 30): Promise<string> {
  if (!USER_ID) return 'BMM_USER_ID not set in brownbot .env — skipping Plaid sync.';
  return bmmFetch('/api/plaid/sync-transactions', {
    method: 'POST',
    body: JSON.stringify({ userId: USER_ID, days }),
  });
}

// Boot-time guard: the finance read tools go straight to the BMM Supabase DB, so
// if any of these three are unset the tools throw and the bot silently falls back
// to week-old cached metric facts ("old numbers"). Returns the missing var names so
// the caller can warn loudly — this exact silent failure is what we're fixing.
export function checkFinanceConfig(): string[] {
  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!USER_ID) missing.push('BMM_USER_ID');
  return missing;
}

export async function checkBmmHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BMM_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`[Finance] BMM healthy at ${BMM_URL}`);
      return true;
    }
    console.warn(`[Finance] BMM at ${BMM_URL} responded with ${res.status}`);
    return false;
  } catch {
    console.warn(`[Finance] BMM unreachable at ${BMM_URL} (set BMM_API_URL to override default)`);
    return false;
  }
}

export const financeTools: ToolDef[] = [
  {
    definition: {
      name: 'finance_health_check',
      description: 'Check if the Brown Man Money finance server is running and accessible.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    handler: async () => {
      const healthy = await checkBmmHealth();
      return healthy
        ? 'Brown Man Money server is running and healthy.'
        : 'Brown Man Money server is NOT running. Start it with: cd ~/Documents/GitHub/brown-man-money && npm start';
    },
  },
  {
    definition: {
      name: 'get_account_balances',
      description: 'Get current balances for all linked bank accounts. Reads directly from the finance DB (no Plaid call).',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    handler: async () => {
      try {
        const userId = requireUser();
        const accounts = await sb(`accounts?user_id=eq.${userId}&is_active=eq.true&select=name,institution,type,balance,currency,last_sync&order=balance.desc`);
        if (!accounts.length) return 'No linked accounts found.';
        const total = accounts.reduce((s: number, a: any) => s + Number(a.balance || 0), 0);
        const lines = accounts.map((a: any) => `  • ${a.institution} ${a.name} (${a.type}): $${Number(a.balance).toFixed(2)} ${a.currency || ''}`.trim());
        return `${accounts.length} accounts, total $${total.toFixed(2)}:\n${lines.join('\n')}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_transactions',
      description: 'Get recent transactions from the finance DB. Filter by date range and/or category.',
      input_schema: {
        type: 'object' as const,
        properties: {
          start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: 30 days ago)' },
          end_date: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
          category: { type: 'string', description: 'Filter by category (e.g. food_and_drink, personal_care)' },
          limit: { type: 'number', description: 'Max rows to return (default 100)' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      try {
        const userId = requireUser();
        const now = new Date();
        const thirty = new Date(now.getTime() - 30 * 86400000);
        const start = (input.start_date as string) || thirty.toISOString().split('T')[0];
        const end = (input.end_date as string) || now.toISOString().split('T')[0];
        const cat = input.category as string | undefined;
        const limit = (input.limit as number) || 100;

        const accounts = await sb(`accounts?user_id=eq.${userId}&select=id,name,institution`);
        if (!accounts.length) return 'No linked accounts; nothing to query.';
        const acctIds = accounts.map((a: any) => a.id);
        const acctMap: Record<string, string> = Object.fromEntries(accounts.map((a: any) => [a.id, `${a.institution} ${a.name}`]));

        let q = `transactions?account_id=in.(${acctIds.join(',')})&transaction_date=gte.${start}&transaction_date=lte.${end}&order=transaction_date.desc&limit=${limit}&select=transaction_date,description,amount,category,type,account_id`;
        if (cat) q += `&category=eq.${cat}`;

        const txns = await sb(q);
        if (!txns.length) return `No transactions found between ${start} and ${end}${cat ? ` in category ${cat}` : ''}.`;

        const lines = txns.map((t: any) => {
          const date = t.transaction_date.split('T')[0];
          const sign = t.type === 'expense' ? '-' : '+';
          return `  ${date}  ${sign}$${Number(t.amount).toFixed(2).padStart(9)}  ${t.category.padEnd(22)}  ${t.description}  [${acctMap[t.account_id]}]`;
        });
        return `${txns.length} transactions (${start} to ${end}${cat ? `, category ${cat}` : ''}):\n${lines.join('\n')}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_spending_summary',
      description: 'Summarize spending by category over a date range. Defaults to last 30 days. Shows total income, expense, and top categories.',
      input_schema: {
        type: 'object' as const,
        properties: {
          start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: 30 days ago)' },
          end_date: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      try {
        const userId = requireUser();
        const now = new Date();
        const thirty = new Date(now.getTime() - 30 * 86400000);
        const start = (input.start_date as string) || thirty.toISOString().split('T')[0];
        const end = (input.end_date as string) || now.toISOString().split('T')[0];

        const accounts = await sb(`accounts?user_id=eq.${userId}&select=id`);
        if (!accounts.length) return 'No linked accounts.';
        const acctIds = accounts.map((a: any) => a.id);

        const txns = await sb(`transactions?account_id=in.(${acctIds.join(',')})&transaction_date=gte.${start}&transaction_date=lte.${end}&select=amount,category,type&limit=10000`);
        if (!txns.length) return `No transactions between ${start} and ${end}.`;

        const byCat: Record<string, number> = {};
        let income = 0, expense = 0;
        for (const t of txns) {
          const amt = Number(t.amount);
          if (t.type === 'expense') {
            expense += amt;
            byCat[t.category] = (byCat[t.category] || 0) + amt;
          } else {
            income += amt;
          }
        }
        const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
        const lines = sorted.slice(0, 10).map(([c, v]) => `  • ${c.padEnd(22)} $${v.toFixed(2)}`);
        return `Spending summary ${start} → ${end} (${txns.length} txns):\n  Income:  $${income.toFixed(2)}\n  Expense: $${expense.toFixed(2)}\n  Net:     $${(income - expense).toFixed(2)}\n\nTop expense categories:\n${lines.join('\n')}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'sync_transactions',
      description: 'Pull fresh transactions from Plaid into the finance DB. Use when balances or recent transactions seem stale. Defaults to last 30 days.',
      input_schema: {
        type: 'object' as const,
        properties: { days: { type: 'number', description: 'Lookback window in days (default 30)' } },
        required: [],
      },
    },
    handler: async (input) => {
      requireUser();
      const days = (input.days as number) || 30;
      return syncPlaidTransactions(days);
    },
  },
  {
    definition: {
      name: 'get_budget_status',
      description: 'Get current budget status showing actual vs target spending per category.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    handler: async () => {
      try {
        const userId = requireUser();
        const budgets = await sb(`budgets?user_id=eq.${userId}&select=*`);
        if (!budgets.length) return 'No budgets defined yet.';
        return JSON.stringify(budgets, null, 2);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'ask_finance_ai',
      description: 'Ask a natural language question about your finances. Uses Claude with the BMM finance backend.',
      input_schema: {
        type: 'object' as const,
        properties: { question: { type: 'string', description: 'Your financial question' } },
        required: ['question'],
      },
    },
    handler: async (input) => {
      return bmmFetch('/api/claude/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: input.question as string }] }),
      });
    },
  },
];

import { sendCommand, isBrowserConnected } from '../browser-bridge.js';
import type { ToolDef, ToolContext } from './index.js';
import { saveFact } from '../db.js';

// Track one tab per group so concurrent sessions don't collide
const sessionTabs = new Map<string, number>();

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return 'browser_clip'; }
}

// Shared core for navigation — both `browser_action({action:'navigate'})`
// and the convenience `browser_navigate` tool flow through this.
async function navigateToUrl(url: string, groupKey: string): Promise<string> {
  if (!isBrowserConnected()) {
    return 'Chrome extension not connected — open Chrome on the Mac mini and ensure the Second Brain Bridge extension is loaded.';
  }
  if (!url || typeof url !== 'string') return 'browser_navigate: missing or non-string url';

  const params: Record<string, unknown> = { url };
  const existingTabId = sessionTabs.get(groupKey);
  if (existingTabId) params.tabId = existingTabId;
  else params.newTab = true;

  try {
    const result = await sendCommand('navigate', params) as Record<string, unknown> & { tabId?: number; title?: string; url?: string; text?: string; links?: Array<{ text: string; url: string }> };
    if (typeof result?.tabId === 'number') sessionTabs.set(groupKey, result.tabId);
    const text = (result.text as string) || '';
    const truncNote = text.length >= 12000 ? '\n\n[Content truncated — page has more text]' : '';
    const links = result.links || [];
    const linkSection = links.length > 0 ? '\n\n## Links on page:\n' + links.map((l) => `- ${l.text}: ${l.url}`).join('\n') : '';
    return `Title: ${result.title}\nURL: ${result.url}\n\n${text}${truncNote}${linkSection}`;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('No tab') || err.message.includes('disconnected'))) {
      sessionTabs.delete(groupKey);
    }
    return `browser_navigate failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const browserTools: ToolDef[] = [
  {
    definition: {
      name: 'browser_action',
      description: `Control the Chrome browser on the Mac mini. Uses real Chrome with all active login sessions (LinkedIn, Gmail, Airtable, etc). Each group gets its own tab automatically.

Actions:
- navigate: Go to a URL, returns page title + text
- click: Click an element by CSS selector or text
- extract_text: Extract text from elements by CSS selector
- get_page_source: Get raw HTML (truncated to 50k chars)
- fill_input: Fill an input field by selector
- submit_form: Submit a form by selector
- wait_for_selector: Wait for an element to appear
- get_current_url: Get active tab URL and title
- list_tabs: List all open tabs
- switch_tab: Switch to a tab by ID`,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [
              'navigate', 'click', 'extract_text', 'get_page_source',
              'fill_input', 'submit_form', 'wait_for_selector',
              'get_current_url', 'list_tabs', 'switch_tab',
            ],
            description: 'The browser action to perform',
          },
          url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
          selector: { type: 'string', description: 'CSS selector (for click, extract_text, fill_input, submit_form, wait_for_selector)' },
          text: { type: 'string', description: 'Text content to find element by (for click action, alternative to selector)' },
          value: { type: 'string', description: 'Value to fill (for fill_input action)' },
          tabId: { type: 'number', description: 'Tab ID (for switch_tab, or to target a specific tab in any action)' },
          timeout: { type: 'number', description: 'Timeout in ms (for wait_for_selector, default 10000)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      if (!isBrowserConnected()) {
        console.log('[browser] tool called but extension not connected');
        return 'Chrome extension not connected — open Chrome on the Mac mini and ensure the Second Brain Bridge extension is loaded.';
      }

      const action = input.action as string;
      const groupKey = context?.groupKey || 'default';
      const params: Record<string, unknown> = {};

      // Pass through all params except action
      for (const [k, v] of Object.entries(input)) {
        if (k !== 'action' && v !== undefined) params[k] = v;
      }

      console.log(`[browser] action=${action} group=${groupKey} input=${JSON.stringify(input).slice(0, 200)}`);

      // Auto-inject the group's tab if no explicit tabId was provided
      if (!params.tabId && action !== 'list_tabs') {
        const existingTabId = sessionTabs.get(groupKey);
        if (existingTabId) {
          params.tabId = existingTabId;
        } else if (action === 'navigate') {
          // First navigation for this group — create a new tab
          params.newTab = true;
        }
      }

      try {
        const result = await sendCommand(action, params);

        if (result && typeof result === 'object') {
          const r = result as Record<string, unknown>;

          // Track the tab ID for this group's session
          if (r.tabId && typeof r.tabId === 'number') {
            sessionTabs.set(groupKey, r.tabId as number);
          }

          // Format navigate results nicely
          if (action === 'navigate' && r.title) {
            const text = r.text as string || '';
            const truncNote = text.length >= 12000 ? '\n\n[Content truncated — page has more text]' : '';
            const links = r.links as Array<{ text: string; url: string }> || [];
            const linkSection = links.length > 0
              ? '\n\n## Links on page:\n' + links.map(l => `- ${l.text}: ${l.url}`).join('\n')
              : '';
            return `Title: ${r.title}\nURL: ${r.url}\n\n${text}${truncNote}${linkSection}`;
          }

          // Format extract_text results
          if (action === 'extract_text' && r.text) {
            const note = r.truncated ? '\n\n[Truncated]' : '';
            return `Found ${r.count} element(s):\n\n${r.text}${note}`;
          }

          // Format get_page_source
          if (action === 'get_page_source' && r.html) {
            const note = r.truncated ? `\n\n[Truncated — full page is ${r.length} chars]` : '';
            return `${r.html}${note}`;
          }

          // Format list_tabs
          if (action === 'list_tabs' && r.tabs) {
            const tabs = r.tabs as Array<{ id: number; title: string; url: string; active: boolean }>;
            const lines = tabs.map(t => `${t.active ? '→ ' : '  '}[${t.id}] ${t.title}\n    ${t.url}`);
            return `${r.count} tab(s):\n\n${lines.join('\n\n')}`;
          }

          return JSON.stringify(result, null, 2);
        }

        return String(result);
      } catch (err) {
        // If tab was closed/crashed, clear it so next request creates a new one
        if (err instanceof Error && (err.message.includes('No tab') || err.message.includes('disconnected'))) {
          sessionTabs.delete(groupKey);
        }
        return `Browser action failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    definition: {
      name: 'browser_navigate',
      description: 'Open a URL in the group\'s Chrome tab. Convenience alias around browser_action({action:"navigate"}). USE WHEN: you have a specific URL to load (a job posting, a LinkedIn profile, a doc). Returns the page title + extracted text + on-page links.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Full URL to open (http:// or https://)' },
        },
        required: ['url'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const { url } = input as { url: string };
      return navigateToUrl(url, context?.groupKey || 'admin');
    },
  },
  {
    definition: {
      name: 'clip_to_facts',
      description: 'Clip the currently-open browser tab into the knowledge store. Saves a clip fact (subject=domain, predicate=clipped, source_ref=URL) and returns the page text so you can structure additional facts via save_fact. USE WHEN: user says "save this", "clip this page", "remember this article", or shares a URL they want stored.',
      input_schema: {
        type: 'object' as const,
        properties: {
          subject: { type: 'string', description: 'Optional subject for the clip fact. Defaults to the page domain (e.g., "techcrunch.com").' },
          note: { type: 'string', description: 'Optional one-line note about why this is being clipped.' },
        },
        required: [],
      },
    },
    handler: async (input, context?: ToolContext) => {
      if (!isBrowserConnected()) return 'Chrome extension not connected — open Chrome on the Mac mini.';
      const groupKey = context?.groupKey || 'admin';
      const tabId = sessionTabs.get(groupKey);
      const { subject, note } = input as { subject?: string; note?: string };

      try {
        const current = await sendCommand('get_current_url', tabId ? { tabId } : {}) as { url?: string; title?: string };
        const url = current.url || '';
        const title = current.title || url || '(no title)';
        if (!url) return 'No active page to clip — navigate first or pass tabId.';

        const factId = saveFact({
          subject: subject || hostnameOf(url),
          predicate: 'clipped',
          object: note ? `${title} — ${note}` : title,
          fact_type: 'fact',
          source: 'clip',
          source_ref: url,
          group_id: groupKey,
        });

        let preview = '';
        try {
          const extract = await sendCommand('extract_text', { selector: 'body', tabId }, 10000) as { text?: string };
          preview = (extract.text || '').slice(0, 4000);
        } catch { /* extract failure is non-fatal — the clip fact is still saved */ }

        const body = preview
          ? `\n\n--- Page text (first 4000 chars) ---\n${preview}\n\nIf there are durable facts in this content, save them via save_fact with source='clip' and source_ref='${url}'.`
          : '\n\n(Could not extract page text — clip fact saved with title only.)';
        return `Clipped #${factId}: ${title}\n${url}${body}`;
      } catch (err) {
        return `clip_to_facts failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];

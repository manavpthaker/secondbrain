import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDef } from './index.js';

const exec = promisify(execFile);

// URL-fetch guardrails. Prevent file://, gopher://, etc. and stop the agent
// from poking at localhost / private IPs from within the LLM loop.
function assertSafeUrl(input: string): URL {
  if (!input || typeof input !== 'string') throw new Error('web: empty url');
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new Error(`web: not a valid URL: ${input}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web: only http/https URLs are allowed (got ${parsed.protocol})`);
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    throw new Error(`web: refusing to fetch private/loopback host ${host}`);
  }
  return parsed;
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // IPv4 dotted-quad
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;    // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  // Rough IPv6 private: anything starting fc/fd (ULA) or fe80 (link-local)
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe80:/i.test(host)) return true;
  return false;
}

// Pin curl to http/https for primary requests AND redirects so a 302 can't
// redirect into file:// or gopher://.
const CURL_PROTO_ARGS = ['--proto', '=http,https', '--proto-redir', '=http,https'];

export const webTools: ToolDef[] = [
  {
    definition: {
      name: 'fetch_url',
      description: 'Fetch the text content of a URL. Useful for reading job descriptions, articles, and web pages.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
    handler: async (input) => {
      const url = input.url as string;
      try {
        assertSafeUrl(url);
      } catch (err) {
        return `fetch_url rejected: ${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        // Use curl to fetch, then strip HTML tags for a rough text extraction.
        // --proto pinning prevents redirects from escaping to file://, gopher://, etc.
        const { stdout } = await exec('curl', [
          '-sL',
          ...CURL_PROTO_ARGS,
          '--max-time', '15',
          '-A', 'Mozilla/5.0',
          url,
        ], { maxBuffer: 1024 * 1024 });

        // Basic HTML → text: strip tags, decode entities, collapse whitespace
        const text = stdout
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .replace(/&#\d+;/g, '')
          .replace(/\s+/g, ' ')
          .trim();

        // Truncate to avoid blowing context
        return text.slice(0, 8000) || 'Page fetched but no readable text found.';
      } catch (err) {
        return `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    definition: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo. Returns titles and snippets.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      const query = input.query as string;
      try {
        // Use DuckDuckGo lite HTML endpoint.
        const { stdout } = await exec('curl', [
          '-sL',
          ...CURL_PROTO_ARGS,
          '--max-time', '10',
          '-A', 'Mozilla/5.0',
          `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
        ], { maxBuffer: 512 * 1024 });

        // Extract result snippets from the lite page
        const results: string[] = [];
        const linkRegex = /<a[^>]+class="result-link"[^>]*>([^<]+)<\/a>/gi;
        const snippetRegex = /<td class="result-snippet">([^<]+)<\/td>/gi;

        const links = [...stdout.matchAll(linkRegex)].map((m) => m[1].trim());
        const snippets = [...stdout.matchAll(snippetRegex)].map((m) => m[1].trim());

        for (let i = 0; i < Math.min(links.length, 5); i++) {
          results.push(`${i + 1}. ${links[i]}\n   ${snippets[i] || ''}`);
        }

        return results.length > 0 ? results.join('\n\n') : 'No search results found.';
      } catch (err) {
        return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];

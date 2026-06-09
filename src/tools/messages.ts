import type { ToolDef } from './index.js';
import { searchIMessages, type IMessageLogRow } from '../db.js';
import { getOwner } from '../config.js';

function messageLine(m: IMessageLogRow): string {
  const when = (m.ts || '').slice(0, 16).replace('T', ' ');
  const who = m.direction === 'out' ? getOwner().name : (m.chat_name || m.sender);
  const chat = m.chat_name && m.chat_name !== who ? ` (${m.chat_name})` : '';
  return `  · ${when}${chat} ${who}: ${(m.text || '').slice(0, 240)}`;
}

export const messagesTools: ToolDef[] = [
  {
    definition: {
      name: 'search_messages',
      description: 'Search the owner\'s iMessage history by keyword and/or person. USE WHEN: the owner asks "what did X say", "find the message about Y", "search my texts", "go through my communications", or you need context on a conversation. Returns matching messages newest-first. Coverage includes backfilled history plus everything observed live; if a search is empty, the topic may simply not be in the log.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Free-text to match against message body, sender, and chat name (e.g. "dinner", "invoice").' },
          person: { type: 'string', description: 'Narrow to a specific sender/chat — a name, phone, or chat title. Optional.' },
          limit: { type: 'number', description: 'Max messages to return (default 20, max 100).' },
        },
      },
    },
    handler: async (input) => {
      const { query, person, limit } = input as { query?: string; person?: string; limit?: number };
      if (!query?.trim() && !person?.trim()) {
        return 'Give me something to search for — a keyword, or a person/chat name.';
      }
      const rows = searchIMessages({ query, handle: person, limit });
      if (rows.length === 0) {
        return `No messages found${query ? ` matching "${query}"` : ''}${person ? ` with ${person}` : ''}.`;
      }
      const header = `Found ${rows.length} message(s)${query ? ` matching "${query}"` : ''}${person ? ` with ${person}` : ''}:`;
      return [header, ...rows.map(messageLine)].join('\n');
    },
  },
];

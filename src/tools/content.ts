import { writeFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import {
  createDraft,
  getDraftById,
  listDrafts,
  updateDraftStatus,
  getUnreviewedDraftsCount,
  getRecentFactsBySource,
  getTopRecentPeople,
  getFactsByType,
  factsByPersonId,
  type Fact,
  type FactDraft,
} from '../db.js';
import { draftsPath } from './path-utils.js';
import type { ToolDef } from './index.js';

// Tier 1 Phase 3: Content Flywheel.
//
// `gather_content_signal` reads from `facts` (source='reflection' / source='jd'
// / fact_type='decision') NOT from `morning_brief_<date>` memory keys — those
// are deleted by the 06:30 calendar prep and would be empty by Saturday.
// The Phase 3 reflection-prompt edit ensures the brief is also saved as a
// `source='reflection'` fact with `valid_until = +30d` so it survives the
// delete but ages out of FTS retrieval long-term.
//
// Drafts land in `the drafts directory at<kind>/<date>-<slug>.md` — outside any
// tracked git repo. brownbot does NOT commit/push into `brown-man-content`;
// the file is for the user to review and hand-publish.

function factSummary(f: Fact): string {
  return `[#${f.id}] ${f.subject} ${f.predicate} ${f.object}`;
}

function draftSummary(d: FactDraft): string {
  const head = `#${d.id} [${d.kind}/${d.status}]`;
  const title = d.title ? ` "${d.title}"` : '';
  const when = d.created_at.slice(0, 10);
  return `${head}${title} (${when})`;
}

export const contentTools: ToolDef[] = [
  {
    definition: {
      name: 'gather_content_signal',
      description: 'Pull the past N days of brain signal that\'s usable as content substrate — reflection insights, JD analyses, decisions, and the people you\'ve interacted with most. Returns a labeled multi-section block. USE WHEN: drafting a LinkedIn post or newsletter blurb. Default window is 7 days.',
      input_schema: {
        type: 'object' as const,
        properties: {
          days: { type: 'number', description: 'Lookback window in days (default 7).' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { days = 7 } = input as { days?: number };
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      const reflections = getRecentFactsBySource('reflection', since, 10);
      const jds = getRecentFactsBySource('jd', since, 10);
      const decisions = getFactsByType(['decision'], 10);
      const recentDecisions = decisions.filter((f) => f.updated_at >= since);
      const people = getTopRecentPeople(since, 5);

      const sections: string[] = [];
      sections.push(`### Reflection insights (${reflections.length})`);
      sections.push(reflections.length === 0 ? '(none)' : reflections.map(factSummary).join('\n'));
      sections.push(`\n### JD analyses (${jds.length})`);
      sections.push(jds.length === 0 ? '(none)' : jds.map(factSummary).join('\n'));
      sections.push(`\n### Decisions in window (${recentDecisions.length})`);
      sections.push(recentDecisions.length === 0 ? '(none)' : recentDecisions.map(factSummary).join('\n'));
      sections.push(`\n### Most-touched people (${people.length})`);
      sections.push(
        people.length === 0
          ? '(none)'
          : people.map((p) => `${p.name} (#person:${p.person_id}) — ${p.count} interaction(s)`).join('\n'),
      );

      const unreviewed = getUnreviewedDraftsCount();
      if (unreviewed > 0) {
        sections.push(`\n### Pending drafts: ${unreviewed}`);
      }

      return sections.join('\n');
    },
  },
  {
    definition: {
      name: 'draft_linkedin_post',
      description: 'Save a LinkedIn post draft. Writes the markdown to the drafts directory atlinkedin/<date>-<slug>.md AND creates a fact_drafts row tracking it. USE WHEN: composing a personal LinkedIn post from brain signal. Cite the source_fact_ids you grounded the post in — DO NOT fabricate metrics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Short headline (used for the filename slug + the draft row title).' },
          body: { type: 'string', description: 'Full post body (markdown OK). Aim ~250 words.' },
          source_fact_ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'Fact ids you used as source material. Required — keeps drafts auditable.',
          },
        },
        required: ['title', 'body', 'source_fact_ids'],
      },
    },
    handler: async (input) => {
      const { title, body, source_fact_ids } = input as { title: string; body: string; source_fact_ids: number[] };
      if (!Array.isArray(source_fact_ids) || source_fact_ids.length === 0) {
        return 'Refusing to draft without source_fact_ids — drafts must cite their substrate.';
      }
      let path: string;
      try {
        path = draftsPath('linkedin', title);
      } catch (err) {
        return `Path rejected: ${err instanceof Error ? err.message : String(err)}`;
      }
      // Collision handling: if the same-date filename exists, append -2, -3, ...
      let finalPath = path;
      let suffix = 2;
      while (existsSync(finalPath)) {
        finalPath = path.replace(/\.md$/, `-${suffix}.md`);
        suffix++;
        if (suffix > 50) return 'Too many collisions for today; rename the title.';
      }
      writeFileSync(finalPath, body, 'utf-8');
      const id = createDraft({ kind: 'linkedin', title, body, source_fact_ids, path: finalPath });
      return `Saved draft #${id} → ${finalPath}`;
    },
  },
  {
    definition: {
      name: 'draft_newsletter_blurb',
      description: 'Save a newsletter blurb draft. Same shape as draft_linkedin_post but writes under the drafts directory atnewsletter/.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          source_fact_ids: { type: 'array', items: { type: 'number' } },
        },
        required: ['title', 'body', 'source_fact_ids'],
      },
    },
    handler: async (input) => {
      const { title, body, source_fact_ids } = input as { title: string; body: string; source_fact_ids: number[] };
      if (!Array.isArray(source_fact_ids) || source_fact_ids.length === 0) {
        return 'Refusing to draft without source_fact_ids.';
      }
      let path: string;
      try {
        path = draftsPath('newsletter', title);
      } catch (err) {
        return `Path rejected: ${err instanceof Error ? err.message : String(err)}`;
      }
      let finalPath = path;
      let suffix = 2;
      while (existsSync(finalPath)) {
        finalPath = path.replace(/\.md$/, `-${suffix}.md`);
        suffix++;
        if (suffix > 50) return 'Too many collisions for today; rename the title.';
      }
      writeFileSync(finalPath, body, 'utf-8');
      const id = createDraft({ kind: 'newsletter', title, body, source_fact_ids, path: finalPath });
      return `Saved draft #${id} → ${finalPath}`;
    },
  },
  {
    definition: {
      name: 'list_drafts',
      description: 'List recent content drafts, optionally filtered by status.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'discarded', 'published'] },
          limit: { type: 'number', description: 'Max rows to return (default 20).' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { status, limit } = input as { status?: string; limit?: number };
      const rows = listDrafts({ status, limit: limit ?? 20 });
      if (rows.length === 0) return 'No drafts on file.';
      return [`Drafts (${rows.length}):`, ...rows.map(draftSummary)].join('\n');
    },
  },
  {
    definition: {
      name: 'approve_draft',
      description: 'Mark a draft approved (status=approved, reviewed_at=now). Does NOT publish — the markdown file stays in the drafts directory at for the user to hand-publish.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const { id } = input as { id: number };
      const draft = getDraftById(id);
      if (!draft) return `No draft #${id}.`;
      updateDraftStatus(id, 'approved');
      return `Approved draft #${id} → ${draft.path ?? '(no path)'}`;
    },
  },
  {
    definition: {
      name: 'discard_draft',
      description: 'Mark a draft discarded. File stays on disk (the user can delete it manually); the row is just hidden from default listings.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const { id } = input as { id: number; reason?: string };
      const draft = getDraftById(id);
      if (!draft) return `No draft #${id}.`;
      updateDraftStatus(id, 'discarded');
      return `Discarded draft #${id}.`;
    },
  },
];

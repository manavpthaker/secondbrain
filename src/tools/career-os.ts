import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ToolDef } from './index.js';
import { saveFact } from '../db.js';
import { slugifyForAnalysis, subjectFromAnalysis } from './path-utils.js';

// The job-search knowledge base directory. Point CAREER_OS_DIR at your own repo
// of rubric/strategy/voice/facts files; this group/tool is optional and only
// useful if that directory exists.
const CAREER_OS_DIR = process.env.CAREER_OS_DIR
  || join(process.env.HOME || '~', 'Documents', 'GitHub', 'career-os');

function readCareerOsFile(relativePath: string): string {
  const fullPath = join(CAREER_OS_DIR, relativePath);
  if (!existsSync(fullPath)) return `File not found: ${relativePath}`;
  return readFileSync(fullPath, 'utf-8');
}

export const careerOsTools: ToolDef[] = [
  {
    definition: {
      name: 'load_jd_rubric',
      description: 'Load the career knowledge base 100-point JD analysis rubric. Returns the full rubric JSON with 10 scoring categories, penalties, and gate checks.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      return readCareerOsFile('advanced/knowledge/rubrics/director_rubric.json');
    },
  },
  {
    definition: {
      name: 'load_positioning_strategies',
      description: 'Load positioning strategies. Returns 8 pre-built positioning angles with role/industry combinations, key metrics, voice blends, and gap mitigation.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      return readCareerOsFile('advanced/knowledge/positioning/strategies.json');
    },
  },
  {
    definition: {
      name: 'load_voice_calibration',
      description: 'Load voice calibration system. Returns the 50/30/20 voice blend (Gawdat/Mulaney/Maher) with dynamic adjustments by context.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      return readCareerOsFile('advanced/knowledge/voice/voice_blend.yaml');
    },
  },
  {
    definition: {
      name: 'load_verified_facts',
      description: "Load verified facts database. Returns ground truth about the user's background: roles, metrics, skills, education, target roles. Use this for gap analysis.",
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      // Try both possible filenames
      const result = readCareerOsFile('advanced/knowledge/narrative/verified_facts.json');
      if (result.startsWith('File not found')) {
        return readCareerOsFile('advanced/knowledge/narrative/verified_facts_FINAL.json');
      }
      return result;
    },
  },
  {
    definition: {
      name: 'save_jd_analysis',
      description: 'Save a completed JD analysis to the job-search context directory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          company: { type: 'string', description: 'Company name' },
          role: { type: 'string', description: 'Role title' },
          analysis: { type: 'string', description: 'Full analysis text (score, gaps, targets, outreach)' },
        },
        required: ['company', 'role', 'analysis'],
      },
    },
    handler: async (input) => {
      const { company, role, analysis } = input as Record<string, string>;
      const { writeFileSync, mkdirSync } = await import('fs');
      const { join: joinPath } = await import('path');
      const { fileURLToPath } = await import('url');
      const { dirname } = await import('path');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const analysesDir = joinPath(__dirname, '..', '..', 'context', 'job-search', 'analyses');
      mkdirSync(analysesDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const slug = slugifyForAnalysis(date, company, role);
      const filePath = joinPath(analysesDir, `${slug}.md`);

      writeFileSync(filePath, analysis, 'utf-8');

      // Index the analysis into the knowledge store so it's retrievable without
      // re-reading the file. One append fact per analysis; pursue/pass decisions
      // surface from the analysis text via a coarse keyword grep. The fact
      // subject mirrors the filename slug (sans date) so retrieval and the
      // on-disk artifact stay aligned.
      try {
        const subject = subjectFromAnalysis(company, role);
        saveFact({
          subject,
          predicate: 'jd_analyzed',
          object: `${role} at ${company} — analyzed ${date}`,
          fact_type: 'fact',
          source: 'jd',
          source_ref: `context/job-search/analyses/${slug}.md`,
        });
        const verdictMatch = /\b(pursue|pass|hold|monitor)\b/i.exec(analysis.slice(0, 2000));
        if (verdictMatch) {
          saveFact({
            subject,
            predicate: 'verdict',
            object: verdictMatch[1].toLowerCase(),
            fact_type: 'decision',
            source: 'jd',
            source_ref: `context/job-search/analyses/${slug}.md`,
          });
        }
      } catch { /* never let fact writes break the file save */ }

      return `Analysis saved to context/job-search/analyses/${slug}.md`;
    },
  },
];

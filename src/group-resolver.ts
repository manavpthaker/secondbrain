export interface GroupConfig {
  key: string;
  name: string;
  tools: string[];
  contextPath: string;
}

const groups: Map<string, GroupConfig> = new Map();

export function initGroups() {
  const defs: { envKey: string; config: Omit<GroupConfig, 'key'> & { key: string } }[] = [
    {
      envKey: 'GROUP_ADMIN',
      config: {
        key: 'admin',
        name: 'Admin',
        tools: ['calendar', 'github', 'web', 'linkedin', 'career-os', 'finance', 'claude-code', 'household', 'browser', 'memory', 'tasks', 'spark', 'people', 'messages', 'recall', 'content', 'actions', 'canairy', 'instacart', 'spotify'],
        contextPath: 'context/admin',
      },
    },
    {
      envKey: 'GROUP_JOB_SEARCH',
      config: {
        key: 'job-search',
        name: 'Job Search',
        tools: ['career-os', 'web', 'linkedin', 'github', 'browser', 'memory', 'tasks', 'people'],
        contextPath: 'context/job-search',
      },
    },
    {
      envKey: 'GROUP_WORK',
      config: {
        key: 'work',
        name: 'Work',
        tools: ['github', 'web', 'claude-code', 'browser', 'memory', 'tasks'],
        contextPath: 'context/work',
      },
    },
    {
      envKey: 'GROUP_FINANCE',
      config: {
        key: 'finance',
        name: 'Finance',
        tools: ['finance', 'memory', 'tasks'],
        contextPath: 'context/finance',
      },
    },
    {
      envKey: 'GROUP_HOME',
      config: {
        key: 'home',
        name: 'Home',
        tools: ['calendar', 'household', 'web', 'browser', 'memory', 'tasks', 'spark', 'people', 'instacart', 'spotify'],
        contextPath: 'context/personal',
      },
    },
    {
      envKey: 'GROUP_HEALTH',
      config: {
        key: 'health',
        name: 'Health',
        tools: ['memory', 'tasks', 'people'],
        contextPath: 'context/health',
      },
    },
  ];

  // Synthetic group used by the nightly reflection job. Not env-gated — registered
  // unconditionally because the scheduler instantiates it directly without going
  // through resolveGroup. Defined here so its config lives next to other groups.

  for (const { envKey, config } of defs) {
    const groupId = process.env[envKey];
    if (groupId) {
      groups.set(groupId, config);
    }
  }
}

function isDM(identifier: string): boolean {
  // iMessage DMs use phone (+1...) or email (user@domain.com)
  // Group chats use identifiers starting with "chat" or "iMessage;+;chat"
  if (identifier.startsWith('+')) return true;
  if (identifier.startsWith('chat') || identifier.startsWith('iMessage;')) return false;
  if (identifier.includes('@') && !identifier.startsWith('chat')) return true;
  return false;
}

export function resolveGroup(remoteJid: string): GroupConfig | null {
  // Check mapped groups first
  const mapped = groups.get(remoteJid);
  if (mapped) return mapped;

  // DMs (phone or email) — treat as admin context with all tools
  if (isDM(remoteJid)) {
    return {
      key: 'admin',
      name: 'Admin',
      tools: ['calendar', 'github', 'web', 'linkedin', 'career-os', 'finance', 'claude-code', 'household', 'browser', 'memory', 'tasks', 'spark', 'people', 'messages', 'recall', 'actions', 'canairy', 'instacart', 'spotify'],
      contextPath: 'context/admin',
    };
  }

  // Unmapped chat — log it so we can capture the ID
  console.log(`[groups] Unmapped chat: ${remoteJid} — add to .env to enable`);
  return null;
}

export function getAllGroups(): GroupConfig[] {
  return Array.from(groups.values());
}

export const REFLECTION_GROUP: GroupConfig = {
  key: 'reflection',
  name: 'Nightly Reflection',
  tools: ['spark', 'calendar', 'finance', 'github', 'memory', 'tasks', 'people'],
  contextPath: 'context/reflection',
};

// Tier 1 Phase 1: Brain Pulse synthetic group. Drives the 11/16 ET proactive
// cron AND (Phase 2) the weekly hygiene summary. Same terse system-initiated
// tone in both cases.
//
// Tool list uses 'memory' (which covers save_fact/search_facts/facts_about per
// toolRegistry); do NOT use 'facts' — it's not a registered key and would be
// silently dropped by getScopedTools.
export const BRAIN_PULSE_GROUP: GroupConfig = {
  key: 'brain-pulse',
  name: 'Brain Pulse',
  tools: ['memory', 'tasks', 'people', 'calendar'],
  contextPath: 'context/brain-pulse',
};

// Tier 1 Phase 3: Content Flywheel synthetic group. Distinct from
// BRAIN_PULSE_GROUP because the tone differs (creative vs terse-system) and
// the tool scope is different (content + spark for thread-context, no tasks/
// calendar). Same not-env-gated pattern as REFLECTION_GROUP.
//
// Tool list uses 'memory' (which covers fact ops); 'facts' is not a real
// registry key.
export const CONTENT_GROUP: GroupConfig = {
  key: 'content',
  name: 'Content Flywheel',
  tools: ['content', 'memory', 'people', 'spark'],
  contextPath: 'context/content',
};

// Idea Pulse synthetic group. Drives the twice-daily (10/15 ET) proactive
// "here's what I could help with / ideas" ping. Distinct from BRAIN_PULSE_GROUP:
// brain-pulse surfaces aging DB rows (stale commitments, expiring facts, dormant
// leads); idea-pulse is generative — grounded in current state but allowed to
// pitch new angles. Broader read scope so the ideas are specific, not generic.
//
// 'memory' covers the fact ops; 'facts' is not a real registry key.
export const IDEA_PULSE_GROUP: GroupConfig = {
  key: 'idea-pulse',
  name: 'Idea Pulse',
  tools: ['memory', 'tasks', 'people', 'calendar'],
  contextPath: 'context/idea-pulse',
};

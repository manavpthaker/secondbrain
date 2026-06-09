import { normalizePhone } from './lib/phone.js';
import { getProfileConfig, type ProfileUser } from './config.js';

export interface User {
  id: string;
  name: string;
  phone: string;
  role: 'admin' | 'member' | 'child';
  tone: 'direct' | 'warm' | 'playful';
  allowedGroups: string[];
}

const users: Map<string, User> = new Map();

// Build a resolvable User from a profile entry. Phone/email come from env vars
// named by the profile (USER_<ID> / USER_<ID>_EMAIL by default), so secrets
// stay in .env and the committed profile carries no PII.
function registerProfileUser(p: ProfileUser): void {
  const phone = (p.phoneEnv && process.env[p.phoneEnv]) || '';
  const email = (p.emailEnv && process.env[p.emailEnv]) || '';

  const user: User = {
    id: p.id,
    name: p.name,
    phone,
    role: p.role,
    tone: p.tone,
    allowedGroups: p.allowedGroups,
  };

  if (phone) users.set(normalizePhone(phone), user);
  if (email) users.set(email.toLowerCase(), user);
}

export function initUsers() {
  const profile = getProfileConfig();
  registerProfileUser(profile.owner);
  for (const member of profile.members) registerProfileUser(member);
}

export function resolveUser(senderJid: string): User | null {
  // Try phone match (normalized to last-10 digits, same as the store keys)
  const phone = normalizePhone(senderJid);
  if (phone) {
    const byPhone = users.get(phone);
    if (byPhone) return byPhone;
  }

  // Try email match (iMessage can use email handles)
  const byEmail = users.get(senderJid.toLowerCase());
  if (byEmail) return byEmail;

  return null;
}

export function isAllowed(user: User, groupKey: string): boolean {
  return user.allowedGroups.includes(groupKey);
}

export function getRedirectMessage(user: User, groupKey: string): string {
  if (user.tone === 'warm') {
    return `Hey ${user.name}! This group isn't set up for you — try messaging me in the Home group instead 🏠`;
  }
  return `${user.name}, you don't have access to the ${groupKey} group.`;
}

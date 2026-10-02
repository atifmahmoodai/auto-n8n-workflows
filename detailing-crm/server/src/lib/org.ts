import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';
import { notFound } from './errors.js';
import { parseSettings, type OrgSettings } from './settings.js';

export interface OrgContext {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  country: string;
  settings: OrgSettings;
}

export async function loadOrg(db: Db, orgId: string): Promise<OrgContext> {
  const row = await one<{
    id: string;
    name: string;
    timezone: string;
    currency: string;
    country: string;
    settings: unknown;
  }>(db, 'SELECT id, name, timezone, currency, country, settings FROM organizations WHERE id = $1', [orgId]);
  if (!row) throw notFound('Organisation');
  return { ...row, settings: parseSettings(row.settings) };
}

import type { Db } from '../db/pool.js';

export type EntityType = 'appointment' | 'customer' | 'invoice' | 'inventory' | 'user' | 'settings' | 'service';

/** Append-only audit trail. Keep details free of personal data (ids and field names, not values). */
export async function logActivity(
  db: Db,
  entry: {
    orgId: string;
    userId: string | null;
    entityType: EntityType;
    entityId: string | null;
    action: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO activity_log (org_id, user_id, entity_type, entity_id, action, details) VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.orgId, entry.userId, entry.entityType, entry.entityId, entry.action, JSON.stringify(entry.details ?? {})],
  );
}

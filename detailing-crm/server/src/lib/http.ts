import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from './errors.js';

const uuid = z.string().uuid();

/** Path ids that are not UUIDs can never exist, so they are reported as 404 rather than 400. */
export function idParam(req: FastifyRequest, name = 'id', what = 'Resource'): string {
  const value = (req.params as Record<string, string> | undefined)?.[name];
  if (!value || !uuid.safeParse(value).success) throw notFound(what);
  return value;
}

export const zId = uuid;
export const zOptionalId = z.union([z.literal('').transform(() => null), z.null(), uuid]).optional();

/** Trimmed optional text: "" and whitespace become null. */
export const zText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const t = (v ?? '').trim();
      return t === '' ? null : t.slice(0, max);
    });

export const zEmail = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined ? undefined : (v ?? '').trim().toLowerCase() || null))
  .refine(
    (v) => v === undefined || v === null || z.string().email().safeParse(v).success,
    'Enter a valid email address',
  );

export const zPage = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

/** Escapes LIKE wildcards in user search text. Use with ESCAPE '\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

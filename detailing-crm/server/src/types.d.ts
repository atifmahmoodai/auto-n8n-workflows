import type { AuthContext } from './auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook for authenticated requests; null otherwise. */
    auth: AuthContext | null;
  }
}

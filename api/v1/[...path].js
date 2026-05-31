import { buildV1RequestPath, forwardToBackend } from '../_lib/forward-to-backend.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Catch-all proxy for every /api/v1/* route.
 * Clients blocked from api.eienone.in can call this Vercel deployment instead.
 *
 * Example:
 *   GET https://<your-vercel-proxy>.vercel.app/api/v1/balance
 *   -> forwards to BACKEND_URL/api/v1/balance
 */
export default async function handler(req, res) {
  const requestPath = buildV1RequestPath(req);
  await forwardToBackend(req, res, requestPath);
}

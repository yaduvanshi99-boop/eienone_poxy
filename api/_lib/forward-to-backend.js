const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

const CORS_ALLOW_HEADERS =
  'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, X-API-Key, X-API-Secret, X-API-Salt, Authorization, x-api-key, x-api-secret, x-api-salt';

export function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
}

export function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getClientIp(req) {
  return (
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for']
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : null) ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

function getClientLocation(req) {
  return {
    country: req.headers['x-vercel-ip-country'] || 'unknown',
    region: req.headers['x-vercel-ip-country-region'] || 'unknown',
    city: req.headers['x-vercel-ip-city'] || 'unknown',
    latitude: req.headers['x-vercel-ip-latitude'] || 'unknown',
    longitude: req.headers['x-vercel-ip-longitude'] || 'unknown',
    timezone: req.headers['x-vercel-ip-timezone'] || 'unknown',
  };
}

function enrichJsonBody(body, clientIp, location) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  body.clientIp = clientIp;
  body.clientLocation = location;

  if (body.metadata === undefined || body.metadata === null) {
    body.metadata = {};
  }

  if (typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
    body.metadata.clientIp = clientIp;
    body.metadata.clientLocation = location;
  } else if (typeof body.metadata === 'string') {
    try {
      const parsedMeta = JSON.parse(body.metadata);
      parsedMeta.clientIp = clientIp;
      parsedMeta.clientLocation = location;
      body.metadata = JSON.stringify(parsedMeta);
    } catch {
      body.metadata = JSON.stringify({
        original_metadata: body.metadata,
        clientIp,
        clientLocation: location,
      });
    }
  }

  return body;
}

async function prepareRequestBody(req, clientIp, location) {
  const rawBody = await readRawBody(req);
  if (!rawBody.length) {
    return undefined;
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return rawBody;
  }

  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    const enriched = enrichJsonBody(parsed, clientIp, location);
    return Buffer.from(JSON.stringify(enriched), 'utf8');
  } catch {
    return rawBody;
  }
}

function buildForwardHeaders(req, clientIp, location) {
  const forwardHeaders = {};

  for (const [key, value] of Object.entries(req.headers)) {
    const lowercaseKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowercaseKey) || lowercaseKey === 'host') {
      continue;
    }
    forwardHeaders[key] = value;
  }

  forwardHeaders['x-forwarded-for'] = clientIp;
  forwardHeaders['x-real-ip'] = clientIp;
  forwardHeaders['x-client-ip'] = clientIp;
  forwardHeaders['x-vercel-proxy'] = '1';

  forwardHeaders['x-client-geo-country'] = location.country;
  forwardHeaders['x-client-geo-region'] = location.region;
  forwardHeaders['x-client-geo-city'] = location.city;
  forwardHeaders['x-client-geo-latitude'] = location.latitude;
  forwardHeaders['x-client-geo-longitude'] = location.longitude;
  forwardHeaders['x-client-geo-timezone'] = location.timezone;

  forwardHeaders['x-vercel-ip-country'] = location.country;
  forwardHeaders['x-vercel-ip-country-region'] = location.region;
  forwardHeaders['x-vercel-ip-city'] = location.city;
  forwardHeaders['x-vercel-ip-latitude'] = location.latitude;
  forwardHeaders['x-vercel-ip-longitude'] = location.longitude;
  forwardHeaders['x-vercel-ip-timezone'] = location.timezone;

  if (req.headers.host) {
    forwardHeaders['x-forwarded-host'] = req.headers.host;
  }
  if (req.headers['x-forwarded-proto']) {
    forwardHeaders['x-forwarded-proto'] = req.headers['x-forwarded-proto'];
  }

  return forwardHeaders;
}

async function pipeBackendResponse(res, backendResponse) {
  backendResponse.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  });

  res.status(backendResponse.status);

  if (backendResponse.status === 204 || backendResponse.status === 304) {
    res.end();
    return;
  }

  const body = Buffer.from(await backendResponse.arrayBuffer());
  res.send(body);
}

/**
 * Forward an incoming Vercel request to BACKEND_URL + requestPath.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} requestPath - Path + query, e.g. /api/v1/balance?foo=bar
 */
export async function forwardToBackend(req, res, requestPath) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const backendUrl = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  const targetUrl = `${backendUrl}${normalizedPath}`;

  const clientIp = getClientIp(req);
  const location = getClientLocation(req);
  const forwardHeaders = buildForwardHeaders(req, clientIp, location);

  try {
    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders,
      redirect: 'manual',
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const body = await prepareRequestBody(req, clientIp, location);
      if (body !== undefined) {
        fetchOptions.body = body;
        forwardHeaders['content-length'] = String(body.length);
      }
    }

    const backendResponse = await fetch(targetUrl, fetchOptions);
    await pipeBackendResponse(res, backendResponse);
  } catch (error) {
    console.error('Error forwarding request to backend:', { targetUrl, error });
    res.status(500).json({
      status: 2,
      message: 'Internal server error in Vercel proxy',
      error: error?.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Build /api/v1/... path (+ query) from a catch-all route handler.
 */
export function buildV1RequestPath(req) {
  if (req.url) {
    const [pathname] = req.url.split('?');
    if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
      return req.url;
    }
  }

  const pathParam = req.query?.path;
  const segments =
    pathParam === undefined ? [] : Array.isArray(pathParam) ? pathParam : [pathParam];
  const pathname = segments.length ? `/api/v1/${segments.join('/')}` : '/api/v1';

  const queryIndex = req.url?.indexOf('?') ?? -1;
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
  return `${pathname}${query}`;
}

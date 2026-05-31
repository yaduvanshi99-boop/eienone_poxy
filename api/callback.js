// Disable Vercel's body parser to get raw stream (crucial for webhook signature verification)
export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, X-API-Key, X-API-Secret, X-API-Salt, Authorization, x-api-key, x-api-secret, x-api-salt'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
  const targetUrl = `${backendUrl}${req.url}`;

  // Extract IP
  const clientIp = req.headers['x-real-ip'] || 
                   (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || 
                   req.socket.remoteAddress || 
                   '127.0.0.1';

  // Extract Location
  const location = {
    country: req.headers['x-vercel-ip-country'] || 'unknown',
    region: req.headers['x-vercel-ip-country-region'] || 'unknown',
    city: req.headers['x-vercel-ip-city'] || 'unknown',
    latitude: req.headers['x-vercel-ip-latitude'] || 'unknown',
    longitude: req.headers['x-vercel-ip-longitude'] || 'unknown',
    timezone: req.headers['x-vercel-ip-timezone'] || 'unknown',
  };

  // Build forward headers
  const forwardHeaders = {};
  Object.keys(req.headers).forEach((key) => {
    const lowercaseKey = key.toLowerCase();
    if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(lowercaseKey)) {
      forwardHeaders[key] = req.headers[key];
    }
  });

  // Inject Resolved IP and Geo-location into headers
  forwardHeaders['x-forwarded-for'] = clientIp;
  forwardHeaders['x-real-ip'] = clientIp;
  forwardHeaders['x-client-ip'] = clientIp;
  
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

  try {
    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders,
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      fetchOptions.body = await getRawBody(req);
    }

    const backendResponse = await fetch(targetUrl, fetchOptions);
    const contentType = backendResponse.headers.get('content-type') || '';

    // Copy response headers back
    backendResponse.headers.forEach((value, name) => {
      if (!['connection', 'keep-alive', 'transfer-encoding', 'content-encoding'].includes(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    });

    res.status(backendResponse.status);

    if (contentType.includes('application/json')) {
      const json = await backendResponse.json();
      res.json(json);
    } else {
      const text = await backendResponse.text();
      res.send(text);
    }
  } catch (error) {
    console.error('Error forwarding callback to backend:', error);
    res.status(500).json({
      status: 2,
      message: 'Internal server error in Vercel callback proxy',
      error: error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}

import {createRemoteJWKSet, jwtVerify} from 'jose';
import {ACCESS_ISSUER} from '../shared/urls.ts';

export interface AccessEnv { ACCESS_AUD?: string; ACCESS_EMAIL?: string }
const accessKeys = createRemoteJWKSet(new URL(`${ACCESS_ISSUER}/cdn-cgi/access/certs`));

export async function hasAccess(request: Request, env: AccessEnv): Promise<boolean> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_AUD || !env.ACCESS_EMAIL) return false;
  try {
    const {payload} = await jwtVerify(token, accessKeys, {
      issuer: ACCESS_ISSUER, audience: env.ACCESS_AUD, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'email'],
    });
    return payload.email === env.ACCESS_EMAIL;
  } catch { return false; }
}

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { connection } from './queue.js';
import type { AuthedRequest, User } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'outbox_session';

/** Session lifetime in milliseconds (7 days). */
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/** Validation schema for password-based login / registration. */
const passwordLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

// ---------------------------------------------------------------------------
// Password helpers
// ---------------------------------------------------------------------------

/**
 * Hash a password with a random (or provided) salt using scrypt.
 * Returns the string `"<salt>:<hash>"`.
 */
function hashPassword(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

/**
 * Return true if `password` matches the stored `"<salt>:<hash>"` string.
 * Uses a timing-safe comparison to prevent timing attacks.
 */
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/** Create a new session record in the database and set the session cookie. */
async function createSession(userId: string, res: express.Response): Promise<void> {
  const sessionId = randomUUID();
  await db.query(
    "insert into user_sessions (id, user_id, expires_at) values ($1, $2, now() + interval '7 days')",
    [sessionId, userId],
  );
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.sessionSecure,
    maxAge: SESSION_MS,
    path: '/',
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Parse the session cookie from the raw `Cookie` header.
 * (express.cookieParser is not used to avoid adding a dependency.)
 */
export function readCookie(req: express.Request, key: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

/** Express middleware that rejects unauthenticated requests with 401. */
export async function requireAuth(
  req: AuthedRequest,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (!sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const result = await db.query<User>(
    `select u.id, u.name, u.email, u.avatar_url
     from user_sessions s
     join users u on u.id = s.user_id
     where s.id = $1 and s.expires_at > now()`,
    [sessionId],
  );

  const user = result.rows[0];
  if (!user) {
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  req.user = user;
  next();
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuthRoutes(app: express.Express): void {
  // ── POST /api/auth/login ─────────────────────────────────────────────────
  // Logs in an existing user or registers a new one with a password.
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const input = passwordLoginSchema.parse(req.body);
      const email = input.email.trim().toLowerCase();

      const existing = (
        await db.query<User & { password_hash: string | null }>(
          'select id, name, email, avatar_url, password_hash from users where email = $1',
          [email],
        )
      ).rows[0];

      let user: User;

      if (existing) {
        // Account exists – verify password.
        if (!existing.password_hash) {
          return res
            .status(409)
            .json({ error: 'This email uses Google login. Continue with Google instead.' });
        }
        if (!verifyPassword(input.password, existing.password_hash)) {
          return res.status(401).json({ error: 'Incorrect email or password.' });
        }
        user = existing;
      } else {
        // New account – derive a display name from the email address.
        const name = email
          .split('@')[0]
          .replace(/[._-]+/g, ' ')
          .replace(/\b\w/g, (letter) => letter.toUpperCase());

        user = (
          await db.query<User>(
            'insert into users(id, google_sub, name, email, password_hash) values($1,$2,$3,$4,$5) returning id,name,email,avatar_url',
            [randomUUID(), `local:${email}`, name, email, hashPassword(input.password)],
          )
        ).rows[0];
      }

      await createSession(user.id, res);
      res.status(200).json({ user });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/auth/google ─────────────────────────────────────────────────
  // Initiates the Google OAuth flow by redirecting to Google's consent screen.
  app.get('/api/auth/google', async (_req, res) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      return res.status(503).json({ error: 'Google OAuth is not configured' });
    }

    // Store a one-time CSRF token in Redis (expires in 10 min).
    const state = randomBytes(24).toString('hex');
    await connection.set(`google-oauth:${state}`, '1', 'EX', 600);

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.googleClientId);
    url.searchParams.set('redirect_uri', config.googleRedirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');

    res.redirect(url.toString());
  });

  // ── GET /api/auth/google/callback ────────────────────────────────────────
  // Handles the redirect from Google after the user consents.
  app.get('/api/auth/google/callback', async (req, res, next) => {
    try {
      // Validate the CSRF state token.
      const state = String(req.query.state ?? '');
      const isValid = await connection.getdel(`google-oauth:${state}`);
      if (!isValid) {
        return res.status(400).send('Invalid or expired Google login request.');
      }

      // Exchange the authorization code for an access token.
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code ?? ''),
          client_id: config.googleClientId ?? '',
          client_secret: config.googleClientSecret ?? '',
          redirect_uri: config.googleRedirect,
          grant_type: 'authorization_code',
        }),
      });
      const token = (await tokenResponse.json()) as { access_token?: string };

      if (!token.access_token) {
        return res.status(400).send('Google sign-in failed.');
      }

      // Fetch the user's profile from Google.
      const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const profile = (await profileResponse.json()) as {
        sub: string;
        name: string;
        email: string;
        picture?: string;
      };

      if (!profile.sub || !profile.email) {
        return res.status(400).send('Google account did not provide an email.');
      }

      // Upsert the user record (create or refresh name / avatar).
      const user = (
        await db.query<User>(
          `insert into users (id, google_sub, name, email, avatar_url)
           values ($1, $2, $3, $4, $5)
           on conflict (google_sub) do update
             set name       = excluded.name,
                 email      = excluded.email,
                 avatar_url = excluded.avatar_url
           returning id, name, email, avatar_url`,
          [randomUUID(), profile.sub, profile.name, profile.email, profile.picture ?? null],
        )
      ).rows[0];

      await createSession(user.id, res);
      res.redirect(config.webOrigin);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/auth/logout ────────────────────────────────────────────────
  app.post('/api/auth/logout', requireAuth, async (req, res) => {
    await db.query('delete from user_sessions where id = $1', [
      readCookie(req, SESSION_COOKIE),
    ]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  // ── GET /api/auth/me ─────────────────────────────────────────────────────
  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });
}

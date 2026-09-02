import type express from 'express';

export type User = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
};

export type AuthedRequest = express.Request & { user?: User };

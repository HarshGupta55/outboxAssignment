import type { Delivery, User } from './types';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

async function call<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const api = {
  googleLogin: () => location.assign(`${API}/api/auth/google`),

  me: () => call<{ user: User }>('/api/auth/me'),

  passwordLogin: (email: string, password: string) =>
    call<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => call<void>('/api/auth/logout', { method: 'POST' }),

  deliveries: (status: string, query: string) =>
    call<{ deliveries: Delivery[] }>(
      query
        ? `/api/emails/search?q=${encodeURIComponent(query)}`
        : `/api/emails?status=${status}`,
    ),

  schedule: (body: unknown) =>
    call<{ count: number }>('/api/emails/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  delivery: (id: string) => call<{ delivery: Delivery }>(`/api/emails/${id}`),

  slack: () => location.assign(`${API}/api/slack/connect`),
};

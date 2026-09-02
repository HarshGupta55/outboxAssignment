import nodemailer from 'nodemailer';
import type { Delivery } from './db.js';

export function isEtherealHost(host: string) {
  return /ethereal\.email$/i.test(host.trim());
}

export function isSmtpAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /535|Invalid login|EAUTH/i.test(message);
}

export async function createEtherealSmtp() {
  const account = await nodemailer.createTestAccount();
  return {
    smtpHost: account.smtp.host,
    smtpPort: account.smtp.port,
    smtpUser: account.user,
    smtpPass: account.pass,
  };
}

export async function resolveSmtp(input: {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
}) {
  const host = input.smtpHost.trim();
  const user = input.smtpUser.trim();
  const pass = input.smtpPass.trim();

  if (isEtherealHost(host) || !user || !pass) {
    return createEtherealSmtp();
  }

  return {
    smtpHost: host,
    smtpPort: input.smtpPort,
    smtpUser: user,
    smtpPass: pass,
  };
}

export function createSmtpTransport(
  delivery: Pick<Delivery, 'smtp_host' | 'smtp_port' | 'smtp_user' | 'smtp_pass'>,
) {
  const port = delivery.smtp_port;
  return nodemailer.createTransport({
    host: delivery.smtp_host.trim(),
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: {
      user: delivery.smtp_user.trim(),
      pass: delivery.smtp_pass.trim(),
    },
  });
}

export type Status = 'scheduled' | 'sending' | 'sent' | 'failed';

export interface User {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content?: string;
}

export interface Delivery {
  id: string;
  recipient_email: string;
  sender_email: string;
  subject: string;
  html: string;
  scheduled_at: string;
  sent_at: string | null;
  status: Status;
  preview_url: string | null;
  error?: string | null;
  attachments?: Attachment[];
}

export interface ApiError {
  error: string;
}

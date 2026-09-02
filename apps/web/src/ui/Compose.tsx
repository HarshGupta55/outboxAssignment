import { ChangeEvent, FormEvent, useState } from 'react';
import { CalendarDays, ChevronLeft, Clock3, Paperclip, Upload, X } from 'lucide-react';
import { api } from './api';
import type { User } from './types';


type Attachment = { id: string; file: File };

const MAX_FILES = 10;
const MAX_FILE_BYTES = 8 * 1024 * 1024;   // 8 MB per file
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB total

/** Extract unique, lower-cased email addresses from an arbitrary string. */
function extractEmails(text: string): string[] {
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return [...new Set(matches.map((addr) => addr.toLowerCase()))];
}

/** ISO datetime string for `minutesFromNow` minutes in the future, truncated to the minute. */
function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);
}

/** ISO datetime string for tomorrow at a given hour (0–23), truncated to the minute. */
function tomorrowAt(hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString().slice(0, 16);
}

/** Read a File and resolve with its base-64–encoded content (data-URL payload only). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

interface ComposeProps {
  user: User;
  onClose: () => void;
  onDone: (count: number) => void;
}

export function Compose({ user, onClose, onDone }: ComposeProps) {
  const [recipients, setRecipients] = useState('');
  const [scheduledAt, setScheduledAt] = useState(minutesFromNow(10));
  const [isSchedulerOpen, setIsSchedulerOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** Import a lead list from a CSV / TXT file and merge it with existing recipients. */
  function handleLeadFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const incoming = extractEmails(String(reader.result));
      setRecipients((current) =>
        [...new Set([...extractEmails(current), ...incoming])].join(', '),
      );
    };
    reader.readAsText(file);
    event.target.value = ''; // allow re-selecting the same file
  }

  /** Validate and add attachment files chosen by the user. */
  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const incoming = [...(event.target.files ?? [])];
    event.target.value = '';

    const currentBytes = attachments.reduce((sum, a) => sum + a.file.size, 0);
    const incomingBytes = incoming.reduce((sum, f) => sum + f.size, 0);
    const exceedsCount = attachments.length + incoming.length > MAX_FILES;
    const exceedsPerFile = incoming.some((f) => f.size > MAX_FILE_BYTES);
    const exceedsTotal = currentBytes + incomingBytes > MAX_TOTAL_BYTES;

    if (exceedsCount || exceedsPerFile || exceedsTotal) {
      setError('Attach up to 10 files, 8 MB each and 20 MB total.');
      return;
    }

    setError('');
    setAttachments((current) => [
      ...current,
      ...incoming.map((file) => ({ id: crypto.randomUUID(), file })),
    ]);
  }

  /** Remove an attachment by its generated ID. */
  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((a) => a.id !== id));
  }

  /** Build the payload and schedule the batch via the API. */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const values = Object.fromEntries(new FormData(event.currentTarget));
    const leadList = extractEmails(recipients);

    if (!leadList.length) {
      setError('Enter a recipient or upload a CSV/text lead list.');
      return;
    }

    setBusy(true);
    setError('');

    try {
      const encodedAttachments = await Promise.all(
        attachments.map(async ({ file }) => ({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          content: await readAsBase64(file),
        })),
      );

      const result = await api.schedule({
        ...values,
        emails: leadList,
        attachments: encodedAttachments,
        scheduledAt: new Date(scheduledAt).toISOString(),
        delaySeconds: Number(values.delaySeconds),
        hourlyLimit: Number(values.hourlyLimit),
        smtpPort: Number(values.smtpPort),
      });

      onDone(result.count);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to schedule emails');
    } finally {
      setBusy(false);
    }
  }

  /** Apply a preset scheduled time and close the scheduler panel. */
  function applyPreset(isoValue: string) {
    setScheduledAt(isoValue);
    setIsSchedulerOpen(false);
  }

  return (
    <div className="composer-page">
      <form onSubmit={handleSubmit}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="compose-head">
          <button type="button" aria-label="Back to dashboard" onClick={onClose}>
            <ChevronLeft />
          </button>
          <h1>Compose New Email</h1>

          <div className="compose-actions">
            <label className="icon-button" title="Attach files">
              <Paperclip size={23} />
              <input type="file" multiple onChange={handleAttachmentChange} />
            </label>

            <button
              type="button"
              className="icon-button"
              aria-label="Send later"
              onClick={() => setIsSchedulerOpen((v) => !v)}
            >
              <Clock3 size={21} />
            </button>

            <button className="send-later" disabled={busy}>
              {busy ? 'Scheduling…' : 'Send'}
            </button>
          </div>

          {/* ── Schedule picker ──────────────────────────────────────── */}
          {isSchedulerOpen && (
            <section className="later-menu">
              <h2>Send Later</h2>

              <label className="date-row">
                <span>Pick date &amp; time</span>
                <CalendarDays size={17} />
                <input
                  aria-label="Pick date and time"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </label>

              <button type="button" onClick={() => applyPreset(tomorrowAt(9))}>
                Tomorrow
              </button>
              <button type="button" onClick={() => applyPreset(tomorrowAt(10))}>
                Tomorrow, 10:00 AM
              </button>
              <button type="button" onClick={() => applyPreset(tomorrowAt(11))}>
                Tomorrow, 11:00 AM
              </button>
              <button type="button" onClick={() => applyPreset(tomorrowAt(15))}>
                Tomorrow, 3:00 PM
              </button>

              <footer>
                <button type="button" onClick={() => setIsSchedulerOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="done" onClick={() => setIsSchedulerOpen(false)}>
                  Done
                </button>
              </footer>
            </section>
          )}
        </header>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <main className="compose-body">
          <Field label="From" name="senderEmail" value={user.email} />

          <div className="line">
            <span>To</span>
            <input
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="recipient@example.com"
              aria-label="To"
            />
            <label className="upload-leads">
              <Upload size={14} /> Upload List
              <input
                accept=".csv,.txt,text/csv,text/plain"
                type="file"
                onChange={handleLeadFileChange}
              />
            </label>
          </div>

          <Field label="Subject" name="subject" placeholder="Subject" />

          <div className="settings">
            <label>
              Delay between 2 emails{' '}
              <input name="delaySeconds" type="number" min="0" defaultValue="2" />
            </label>
            <label>
              Hourly Limit{' '}
              <input name="hourlyLimit" type="number" min="1" defaultValue="200" />
            </label>
          </div>

          <div className="editor">
            <div className="reply-label">Type Your Reply...</div>
            <div className="editor-tools">
              ↶　↷　│　Tt⌃　│　<b>B</b>　<em>I</em>　<u>U</u>　│　☰　⌃　│　1≡　•≡　›≡　≡‹　❝　▤　│　S̶
            </div>
            <textarea name="html" required aria-label="Email body" />
          </div>

          {/* ── Attachment list ──────────────────────────────────────── */}
          {attachments.length > 0 && (
            <ul className="attachments">
              {attachments.map(({ id, file }) => (
                <li key={id}>
                  <Paperclip size={13} />
                  <span>{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeAttachment(id)}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Hidden SMTP defaults (Ethereal). Override via settings if needed. */}
          <input type="hidden" name="smtpHost" value="smtp.ethereal.email" />
          <input type="hidden" name="smtpPort" value="587" />
          <input type="hidden" name="smtpUser" value="" />
          <input type="hidden" name="smtpPass" value="" />

          {error && <p className="error">{error}</p>}
        </main>
      </form>
    </div>
  );
}

interface FieldProps {
  label: string;
  name: string;
  value?: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
}

function Field({ label, name, value, placeholder, type = 'text', required = true }: FieldProps) {
  return (
    <label className="line">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={value}
        placeholder={placeholder}
        required={required}
      />
    </label>
  );
}

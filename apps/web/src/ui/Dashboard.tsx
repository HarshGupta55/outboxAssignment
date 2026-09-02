import { useEffect, useState } from 'react';
import { Clock3, LogOut, Paperclip, RefreshCw, Search, Send, X } from 'lucide-react';
import { api } from './api';
import { Compose } from './Compose';
import type { Delivery, User } from './types';

type Tab = 'scheduled' | 'sent';

export function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('scheduled');
  const [rows, setRows] = useState<Delivery[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [compose, setCompose] = useState(false);
  const [toast, setToast] = useState('');
  const [preview, setPreview] = useState<Delivery | null>(null);
  const [previewError, setPreviewError] = useState('');

  const load = () => {
    setLoading(true);
    api
      .deliveries(tab, query)
      .then((result) => {
        setRows(result.deliveries);
        setError('');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const timer = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [tab, query]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="wordmark">ONB</div>
        <button className="compose" onClick={() => setCompose(true)}>
          Compose New Email
        </button>
        <p className="label">CORE</p>
        <button
          className={`nav ${tab === 'scheduled' ? 'active' : ''}`}
          onClick={() => setTab('scheduled')}
        >
          <Clock3 />
          Scheduled Emails
        </button>
        <button className={`nav ${tab === 'sent' ? 'active' : ''}`} onClick={() => setTab('sent')}>
          <Send />
          Sent Emails
        </button>
        <button className="slack" onClick={api.slack}>
          Connect Slack
        </button>
      </aside>

      <main className="inbox">
        <header className="top-header">
          <label>
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search emails"
            />
          </label>
          <div className="profile">
            {user.avatar_url ? <img src={user.avatar_url} alt="" /> : <span>{user.name[0]}</span>}
            <div>
              <b>{user.name}</b>
              <small>{user.email}</small>
            </div>
            <button title="Logout" onClick={onLogout}>
              <LogOut size={15} />
            </button>
          </div>
        </header>

        <section className="list-header">
          <div>
            <h1>{tab === 'scheduled' ? 'Scheduled Emails' : 'Sent Emails'}</h1>
            <p>{tab === 'scheduled' ? 'Emails waiting to be delivered' : 'Delivery history'}</p>
          </div>
          <button className="refresh" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
        </section>

        <DeliveryList
          rows={rows}
          loading={loading}
          error={error}
          sent={tab === 'sent'}
          onCompose={() => setCompose(true)}
          onPreview={(id) => {
            setPreviewError('');
            api
              .delivery(id)
              .then((result) => setPreview(result.delivery))
              .catch((err: Error) => setPreviewError(err.message));
          }}
        />
      </main>

      {preview && <EmailPreview delivery={preview} onClose={() => setPreview(null)} />}
      {previewError && <div className="toast">{previewError}</div>}

      {compose && (
        <Compose
          user={user}
          onClose={() => setCompose(false)}
          onDone={(count) => {
            setCompose(false);
            setTab('scheduled');
            setToast(`${count} email${count === 1 ? '' : 's'} scheduled`);
            load();
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function DeliveryList({
  rows,
  loading,
  error,
  sent,
  onCompose,
  onPreview,
}: {
  rows: Delivery[];
  loading: boolean;
  error: string;
  sent: boolean;
  onCompose: () => void;
  onPreview: (id: string) => void;
}) {
  if (loading) {
    return <div className="state">Loading emails…</div>;
  }

  if (error) {
    return <div className="state error">{error}</div>;
  }

  if (!rows.length) {
    return (
      <div className="state">
        <Send />
        <b>No {sent ? 'sent' : 'scheduled'} emails</b>
        <p>
          {sent
            ? 'Delivered emails will appear here.'
            : 'Create your first campaign to get started.'}
        </p>
        {!sent && (
          <button className="compose small" onClick={onCompose}>
            Compose New Email
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="table">
      <div className="tr th">
        <span>Email</span>
        <span>Subject</span>
        <span>{sent ? 'Sent time' : 'Scheduled time'}</span>
        <span>Status</span>
      </div>
      {rows.map((row) => (
        <div
          className={`tr${sent ? ' tr-clickable' : ''}`}
          key={row.id}
          role={sent ? 'button' : undefined}
          tabIndex={sent ? 0 : undefined}
          onClick={sent ? () => onPreview(row.id) : undefined}
          onKeyDown={
            sent
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onPreview(row.id);
                  }
                }
              : undefined
          }
        >
          <span>{row.recipient_email}</span>
          <b>
            {row.subject}
            {row.attachments?.length ? (
              <Paperclip size={11} aria-label={`${row.attachments.length} attachment${row.attachments.length === 1 ? '' : 's'}`} />
            ) : null}
          </b>
          <span>
            {new Date(sent && row.sent_at ? row.sent_at : row.scheduled_at).toLocaleString()}
          </span>
          <span className={`status ${row.status}`} title={row.error || undefined}>
            {row.status}
          </span>
        </div>
      ))}
    </div>
  );
}

function previewHtml(html: string) {
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(html);
  const body = looksLikeHtml
    ? html
    : html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px Inter,Arial,sans-serif;color:#303846;margin:16px;line-height:1.5}</style></head><body>${body}</body></html>`;
}

function EmailPreview({ delivery, onClose }: { delivery: Delivery; onClose: () => void }) {
  const images = (delivery.attachments ?? []).filter(
    (file) => file.content && file.contentType.startsWith('image/'),
  );
  const files = (delivery.attachments ?? []).filter(
    (file) => !file.contentType.startsWith('image/'),
  );

  return (
    <div className="preview-page" role="dialog" aria-label="Email preview">
      <div className="preview-card">
        <header className="preview-head">
          <h1>{delivery.subject}</h1>
          <button type="button" onClick={onClose} aria-label="Close preview">
            <X size={16} />
          </button>
        </header>
        <dl className="preview-meta">
          <div>
            <dt>From</dt>
            <dd>{delivery.sender_email}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{delivery.recipient_email}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd>{new Date(delivery.sent_at || delivery.scheduled_at).toLocaleString()}</dd>
          </div>
        </dl>
        <iframe className="preview-frame" sandbox="" srcDoc={previewHtml(delivery.html || '')} title="Email body" />
        {images.length > 0 && (
          <div className="preview-images">
            {images.map((file) => (
              <figure key={file.filename}>
                <img
                  src={`data:${file.contentType};base64,${file.content}`}
                  alt={file.filename}
                />
                <figcaption>{file.filename}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <ul className="preview-files">
            {files.map((file) => (
              <li key={file.filename}>
                <Paperclip size={12} /> {file.filename}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

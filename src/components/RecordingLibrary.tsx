import { useCallback, useEffect, useState } from 'react';

type RecordingStatus = 'ready' | 'review' | 'failed';

interface RecordingArchive {
  id: string;
  createdAt: string;
  status: RecordingStatus;
  assets: Record<string, { size: number; mimeType: string }>;
  metadata: Record<string, unknown>;
}

const statusLabels: Record<RecordingStatus, string> = {
  ready: 'Ready',
  review: 'Needs review',
  failed: 'Failed',
};

export function RecordingLibrary() {
  const [archives, setArchives] = useState<RecordingArchive[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/recordings');
      if (!response.ok) throw new Error(`Library request failed (${response.status})`);
      setArchives(await response.json());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load recording library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section aria-label="Recording library">
      <div className="flex items-center justify-between gap-3">
        <h2>Recording library</h2>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && archives.length === 0 && <p>No archived recordings.</p>}
      <ul>
        {archives.map((archive) => (
          <li key={archive.id}>
            <span>{new Date(archive.createdAt).toLocaleString()}</span>{' '}
            <span data-status={archive.status}>{statusLabels[archive.status]}</span>{' '}
            {archive.status !== 'failed' && (
              <a href={`/api/recordings/${archive.id}/download`} download>
                Download master
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

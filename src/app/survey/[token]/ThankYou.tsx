export function ThankYou({
  submittedAt,
  recipientName,
}: {
  submittedAt: Date;
  recipientName: string;
}) {
  return (
    <main style={{ background: '#f7f3ea', minHeight: '100vh' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '60px 16px' }}>
        <div
          style={{
            background: '#fff',
            padding: '40px 32px',
            borderRadius: 6,
            border: '1px solid #e8e2d4',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              background: '#a3151a',
              color: '#fff',
              padding: '16px 20px',
              borderRadius: 6,
              marginBottom: 24,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>St. Vincent de Paul · DR3</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>
              DR3 Operational Intelligence
            </div>
          </div>
          <h1 style={{ fontSize: 22, margin: '0 0 12px', color: '#1a1a1a' }}>
            Thank you, {recipientName}.
          </h1>
          <p style={{ fontSize: 14, color: '#666', margin: '0 0 8px' }}>
            Your responses were submitted on {submittedAt.toISOString().slice(0, 10)} at{' '}
            {submittedAt.toISOString().slice(11, 16)} UTC.
          </p>
          <p style={{ fontSize: 13, color: '#999', margin: '24px 0 0' }}>
            If you need to amend your responses, reply to the original email and Bill can
            reopen your invite.
          </p>
        </div>
      </div>
    </main>
  );
}

// Minimal email sender for auth flows. Uses Resend HTTP API directly so
// we don't need a runtime SDK package. If RESEND_API_KEY is unset, falls
// back to logging the message to stdout — keeps the bootstrap path
// usable before the API key is provisioned.

type SendArgs = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail({ to, subject, text, html }: SendArgs): Promise<void> {
  const apiKey = process.env['RESEND_API_KEY'];
  const from = process.env['EMAIL_FROM'] ?? 'no-reply@dr3-vision.svdp.us';

  if (!apiKey) {
    console.info('[email:stub]', { to, from, subject, text });
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text, html: html ?? text }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}

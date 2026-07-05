// ADR-0045 D3 — contact-intake request validation (zod) + honeypot.
//
// The public endpoint is token-guarded, but validation is still strict: a
// malformed body is a 422, never a partial write. `topic` and `message` are
// required; `name`/`email`/`phone` are optional visitor PII (never logged). The
// honeypot field `website` must be empty — bots fill it; a filled honeypot is a
// silent accept (200) that writes nothing.

import { z } from 'zod';

/** Honeypot field name. Rendered hidden on the WP form; humans leave it blank. */
export const HONEYPOT_FIELD = 'website';

export const contactIntakeSchema = z.object({
  topic: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(5000),
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(320).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  source_form: z.string().trim().min(1).max(120).default('website-contact'),
  // Honeypot — accepted through validation (so a bot never learns it exists via
  // a 422); the SERVICE inspects it and silently drops a filled value as a bot.
  [HONEYPOT_FIELD]: z.string().max(200).optional(),
});

export type ContactIntakeInput = z.infer<typeof contactIntakeSchema>;

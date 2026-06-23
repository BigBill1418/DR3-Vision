import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { generateToken } from '@/lib/survey/tokens';
import type { QuestionInput } from '@/lib/survey/types';

const CAMPAIGN_SLUG = 'dr3-intel-2026-06';
const CAMPAIGN_TITLE = 'DR3 Operational Intelligence — June 2026';

const INTRO_TEXT = `I'm collecting input from across the DR3 team to help build a better data management system — one that improves how we operate, tracks what we do more reliably, frees up your time on data entry, and gives everyone from the floor to leadership a clearer operational picture.

This survey was created by me so we can gather what each of you knows about the systems and processes you touch — what works, what doesn't, and what would make your work easier. Your responses will feed directly into the design of a new DR3 data management system intended to safeguard and automate processes within the DR3 department, free up staff time, verify we have correct data, and improve overall operational tracking.

Responses save as you type; you can come back to finish later. No login required. Should take 20-45 minutes depending on how much detail you want to share. More detail is better, but skip what doesn't apply. Reply to this email if anything is unclear.

— Bill Barnard, Director of Operations`;

// The closing question appended to every packet.
const CLOSING_QUESTION: QuestionInput = {
  position: 9999, // re-numbered at insert
  kind: 'long_text',
  prompt: 'What are we missing? What should we be looking at that we haven\'t asked about?',
  description:
    'Anything that didn\'t fit the questions above. Operational pain points, data quality issues, blind spots, ideas, concerns, side topics — whatever you think we should know.',
  is_required: false,
};

interface InvitePacket {
  recipient_name: string;
  recipient_email: string;
  role_label: string;
  questions: QuestionInput[];
}

const PACKETS: InvitePacket[] = [
  // ─── 1. Bethany Cartledge — Executive Director ────────────────
  {
    recipient_name: 'Bethany Cartledge',
    recipient_email: 'bethany.cartledge@svdp.us', // adjust if needed
    role_label: 'Executive Director',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'What does the board ask you about DR3 most often that you don\'t have great data for today?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'When you talk about DR3 publicly — donors, MRC, regulators, community — what numbers do you wish you could quote with confidence?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'DR3 funds SVdP human services. What is the most important "DR3 funds X human services" data we should be able to show?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'What concerns about DR3 operations reach you that you suspect better data could address?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'If you opened a single DR3 dashboard once a week, what 5 numbers or metrics should be on it?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'When ADR-0033\'s financial integration roadmap item lands, what financial picture do you most want to see — DR3 contribution to SVdP services, per-facility cost recovery, something else?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'Are there mission/board reporting deadlines that should drive Vision\'s reporting cadence?',
      },
    ],
  },

  // ─── 2. Leisha Wallace — Personnel ────────────────────────────
  {
    recipient_name: 'Leisha Wallace',
    recipient_email: 'leisha.wallace@svdp.us',
    role_label: 'Personnel Director',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'What\'s the history of DR3 you\'ve witnessed? Key changes in process, staffing, or scope.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'From a personnel perspective — what longitudinal data do you wish we tracked about DR3 staff that we don\'t today? (Tenure patterns, role progression, bonus history vs retention, attendance trends, anything else.)',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt: 'What recurring HR questions about DR3 do you find yourself piecing together from multiple sources?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'Are there compliance or regulatory tracking needs specific to DR3 staff that we should bake into the new system?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'What employee-facing reports would help your work? Per-employee production history, bonus earnings history, tenure milestones, etc.',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'Without crossing into individual-sensitive territory — what aggregate workforce metrics about DR3 should leadership see?',
      },
    ],
  },

  // ─── 3. Shannon Rockwell — Stores Operations / Rick\'s supervisor ──
  {
    recipient_name: 'Shannon Rockwell',
    recipient_email: 'shannon.rockwell@svdp.us',
    role_label: 'Director of Stores Operations',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'As Rick\'s supervisor — what data do you currently get from him about DR3 operations, and how (email, paper, conversation, ad-hoc)?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt: 'What about Eugene\'s DR3 operations do you wish you had real-time visibility into?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'What\'s the cadence of your DR3 oversight work — daily check-ins, weekly reviews, monthly meetings?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'What reports do you produce upward about DR3, and where does the data for them come from today?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt: 'What cross-site visibility (Eugene vs Woodland) do you want as a supervisor?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'How does DR3 connect to Stores operations beyond reporting? Are there Stores-to-DR3 material flows or coordination points we should track?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'What\'s the biggest gap between what you know about DR3 today and what you wish you knew?',
      },
    ],
  },

  // ─── 4. Mary Scott — Accounting / GP entry for MRC billing ───────
  {
    recipient_name: 'Mary Scott',
    recipient_email: 'mary.scott@svdp.us',
    role_label: 'Accounting / Great Plains Entry for MRC Billing',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'Walk me through your process for MRC billing — what comes to you from Rick, in what format, and what do you do with it?',
      },
      {
        position: 2,
        kind: 'single_select',
        prompt:
          'Which Great Plains integration mechanism does SVdP use for entering invoice data today?',
        options: [
          { label: 'eConnect (XML integration)', value: 'econnect' },
          { label: 'SmartConnect (CSV/Excel templates mapped to GP tables)', value: 'smartconnect' },
          { label: 'Integration Manager (built-in GP IM tool)', value: 'integration_manager' },
          { label: 'Direct entry through the GP UI (no automation)', value: 'direct_entry' },
          { label: 'Something else — describe in the closing question', value: 'other' },
          { label: 'I don\'t know', value: 'unknown' },
        ],
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'What does the GP customer record for MRC look like? Customer ID, default GL accounts, terms, anything else relevant.',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'What goes wrong most often in the MRC billing process today? Where do errors creep in, what gets caught late, what gets caught only after MRC pushes back?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'If you could specify the exact file or format you wanted to receive from Rick (or from a Vision system) to make GP entry painless, what would it look like? Columns, fields, format, naming convention, anything.',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'How are credits and adjustments to MRC invoices handled today? Walk through a real example if possible.',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'What\'s the close cadence — when do you cut off MRC invoices for the month, and when do they need to be entered in GP?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt: 'Are there other DR3-related entries you make in GP beyond MRC invoices? Payroll, expense, etc.',
      },
    ],
  },

  // ─── 5. Rick Albritton — Eugene + MRC billing contact ──────────
  {
    recipient_name: 'Rick Albritton',
    recipient_email: 'rick.albritton@svdp.us',
    role_label: 'Eugene Manager + MRC Billing Contact',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'Walk me through how you produce the data Mary uses to bill MRC. What sources do you pull from, what calculations do you do, what format do you send her, what cadence?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'For California Woodland — when do you cut off the mid-month invoice? Strictly the 15th regardless of weekday, last business day on or before the 15th, first business day on or after, or some other rule?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'Does Eugene have a daily log spreadsheet or equivalent? If not, how is daily Eugene production captured? Who does it, when, with what?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'How do you coordinate between Eugene and Woodland operationally? Container moves, material transfers, shared resources, staff coverage, anything.',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Where does MRC reconciliation happen — do you compare what MRC shows in their portal against what you\'ve billed? What does that process look like, and how often do discrepancies show up?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'What\'s the fuel surcharge formula for CA? How is it calculated each month? Where does the diesel index come from?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'On every row of the Woodland daily log, the DR3 # and Material # appear as sequential numbers. How are these assigned? Who picks the next number, from what source, when?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt: 'What about the spreadsheet or process frustrates you most? Where do errors creep in?',
      },
      {
        position: 9,
        kind: 'long_text',
        prompt:
          'If Vision generated a clean MRC billing data package automatically, what would need to be in it for you to trust it? What checks would you want to see before approving?',
      },
      {
        position: 10,
        kind: 'long_text',
        prompt: 'What\'s the Oregon fee schedule going forward? Per-unit, per-site collection, transport, anything else.',
      },
    ],
  },

  // ─── 6. Janette Tomas — Woodland Manager ─────────────────────────
  {
    recipient_name: 'Janette Tomas',
    recipient_email: 'janette.tomas@svdp.us',
    role_label: 'Woodland Manager',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'Walk me through your daily routine with the Woodland daily log spreadsheet (e.g. JUNE_2026_DAILY_LOG_WOODLAND.xlsm). When do you enter what? Real-time during the day, or all at once at end of day?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'The DR3 # and Material # sequences on each row — how are these assigned? Who picks the next number, from what source, and when? Are these used in MRC reporting or just internal?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'The "office use only" columns on the daily sheets — what do you enter there and when?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'Container rentals at collection sites — how does the operational reality work? Trailers placed, swapped, picked up? Or simpler than that? How is the rental count tracked and reconciled to the monthly invoice?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Events like the Chico Event — how often do these happen? What\'s your involvement? What information do you need to capture, and how do you capture it today?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'In June 2026\'s daily log, day 10 had "Terex is down" written into a numeric cell. Where do you record equipment status, downtime, repairs today? Is there a better way?',
      },
      {
        position: 7,
        kind: 'single_select',
        prompt: 'For photo or document capture (BOL photos, weight ticket photos) — would attaching photos to each daily-log row help your work?',
        options: [
          { label: 'Yes, on every row — would replace paper retention', value: 'every_row' },
          { label: 'Yes, on outbound rows specifically (BOL + weight ticket)', value: 'outbound_only' },
          { label: 'Sometimes — depends on the situation', value: 'sometimes' },
          { label: 'No — would slow things down too much', value: 'no' },
          { label: 'I don\'t know yet', value: 'unknown' },
        ],
      },
      {
        position: 8,
        kind: 'long_text',
        prompt:
          'Has the spreadsheet template changed over time? What versions have you seen? Any major shifts that would matter when we try to import historical data?',
      },
      {
        position: 9,
        kind: 'long_text',
        prompt:
          'The inventory cap of 3,500 units at Woodland — when does the facility actually hit it? What do you do when capacity is reached? Have you ever had to turn trucks away?',
      },
      {
        position: 10,
        kind: 'long_text',
        prompt: 'What about the spreadsheet or current process frustrates you most? What do you wish was different?',
      },
    ],
  },

  // ─── 7. Morena Gomez — California Operations ─────────────────────
  {
    recipient_name: 'Morena Gomez',
    recipient_email: 'morena.gomez@svdp.us',
    role_label: 'DR3 California Operations Manager',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'As CA operations manager — what\'s your visibility across the CA facility today? What do you check daily, weekly, monthly? In what tools or formats?',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'Where has the spreadsheet been wrong in ways you\'ve caught? Tell me a few specific examples — what was wrong, how was it caught, what was the impact?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'What cross-facility coordination work do you do that paper or email handles today? Material moves, shared resources, staffing, anything.',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'What dashboard would you want to see when you open Vision in the morning? What 5 things tell you "is CA OK today?"',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'You\'ve seen Vision\'s daily reconciliation reports recently. What did you do with that data? Was it useful? What would you change about it?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'What systems and tools do you use most often in your work, and what do you wish you could replace?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'Now that Stockton has wound down, what\'s the CA facility footprint going forward? Anything Vision needs to know about future expansion or contraction at Woodland?',
      },
    ],
  },

  // ─── 8. Kelsey Ruhland — Data / Compliance ───────────────────────
  {
    recipient_name: 'Kelsey Ruhland',
    recipient_email: 'kelsey.ruhland@svdp.us',
    role_label: 'Data / Compliance',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt:
          'What MRC reporting do you handle? Cadence, format, who you submit to, what gets verified before submission.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'The per-unit fee schedule for CA — the daily log shows 2026=$16.50 and 2027=$17.00. Is that the verified schedule going forward? And what\'s Oregon\'s schedule for 2026 and 2027?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'Re-Trac IDs on each collection site — how does Re-Trac fit into the picture? What goes in there, when, by whom?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt:
          'What audit and retention requirements should the new system bake in? How long do we keep daily logs, BOLs, photos, anything else?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt: 'What compliance reports do you generate for DR3, and what data do you need for them?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'CalRecycle reporting — what\'s your involvement and what frequency?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt:
          'If MRC enabled API access tomorrow (we requested it 2026-05-04 and haven\'t heard back), what would you want Vision to do with it? Pull-only? Pull + write-back? Reconciliation alerts?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt:
          'Where do you currently catch errors before they reach MRC? What\'s the verification process today and where could automation help most?',
      },
      {
        position: 9,
        kind: 'long_text',
        prompt:
          'For state-by-state rules — what fee categories are allowed in each state? OR has confirmed no fuel surcharge; what other asymmetries between CA and OR should Vision know about?',
      },
    ],
  },

  // ─── 9. Juan — Woodland production floor ─────────────────────────
  {
    recipient_name: 'Juan',
    recipient_email: 'juan@svdp.us', // adjust if needed
    role_label: 'Woodland Production Floor',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'From the floor — what equipment and processes do you work with? Walk me through a typical shift.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'Equipment downtime — when something breaks (like the Terex), how is that recorded today? What goes into the spreadsheet, what stays word-of-mouth, what gets lost?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt:
          'Quality issues — when a mattress can\'t be processed (wet, damaged, illegal contents inside), what happens and how is it recorded?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'What slows production down most often? What would you change if you could?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Production volume — is the number recorded each day accurate to what you actually processed? What would make it more accurate?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt: 'What information do you wish supervisors had about the floor that they don\'t today?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'Safety — are there safety events or near-misses that should be tracked alongside production?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt:
          'For your role specifically — what would make the work easier? Better tools, better data, better coordination, anything.',
      },
    ],
  },

  // ─── 10. Patrick Dills — Eugene lead processor ────────────────────
  {
    recipient_name: 'Patrick Dills',
    recipient_email: 'patrick.dills@svdp.us',
    role_label: 'Eugene Lead Processor',
    questions: [
      {
        position: 1,
        kind: 'long_text',
        prompt: 'From the Eugene floor — what equipment and processes do you work with? Walk me through a typical shift.',
      },
      {
        position: 2,
        kind: 'long_text',
        prompt:
          'The bonus system — how does it look from the processor\'s side? What\'s working, what\'s not, what would you change?',
      },
      {
        position: 3,
        kind: 'long_text',
        prompt: 'What\'s the difference between how Eugene and Woodland operate that you\'ve noticed?',
      },
      {
        position: 4,
        kind: 'long_text',
        prompt: 'Equipment downtime, quality issues, safety events — how are these handled in Eugene today?',
      },
      {
        position: 5,
        kind: 'long_text',
        prompt:
          'Production volume tracking — is it accurate to what actually happens on the floor? What would improve it?',
      },
      {
        position: 6,
        kind: 'long_text',
        prompt:
          'As a lead processor — what information do you wish other processors had access to? What would help them work better?',
      },
      {
        position: 7,
        kind: 'long_text',
        prompt: 'What dashboards or screens would processors themselves benefit from seeing?',
      },
      {
        position: 8,
        kind: 'long_text',
        prompt: 'What about the daily routine frustrates you most? What would you fix first if you could?',
      },
    ],
  },
];

export async function seedSurveyIntelCampaign(ownerUserId: string): Promise<void> {
  const existing = await prisma.surveyCampaign.findUnique({ where: { slug: CAMPAIGN_SLUG } });
  if (existing) return;

  await prisma.$transaction(async (tx) => {
    const campaign = await tx.surveyCampaign.create({
      data: {
        title: CAMPAIGN_TITLE,
        slug: CAMPAIGN_SLUG,
        intro_text: INTRO_TEXT,
        created_by_user_id: ownerUserId,
        status: 'draft',
      },
    });

    for (const packet of PACKETS) {
      const allQuestions: QuestionInput[] = [
        ...packet.questions,
        { ...CLOSING_QUESTION, position: packet.questions.length + 1 },
      ];
      const token = generateToken();
      await tx.surveyInvite.create({
        data: {
          campaign_id: campaign.id,
          recipient_name: packet.recipient_name,
          recipient_email: packet.recipient_email.toLowerCase(),
          role_label: packet.role_label,
          token,
          status: 'draft',
          questions: {
            create: allQuestions.map((q) => ({
              position: q.position,
              kind: q.kind,
              prompt: q.prompt,
              description: q.description ?? null,
              options: q.options == null ? Prisma.JsonNull : (q.options as unknown as Prisma.InputJsonValue),
              is_required: q.is_required ?? false,
            })),
          },
        },
      });
    }
  });
}

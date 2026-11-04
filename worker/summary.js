// A short weekly summary of his patterns, written by Claude from summary statistics only:
// percentages and medians, never raw readings, times of day of single meals, or names.
// It describes; it never suggests doses, ratios or factors.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { combineBlocks, mealTypeStats, readDays } from './insights.js';

export const SummarySchema = z.object({
  headline: z.string(),
  points: z.array(z.string()).max(3),
  discussWithTeam: z.string().nullable(),
});

const SYSTEM = `You write a short weekly summary of glucose patterns for the parents of a child with type 1 diabetes, inside their carb-counting app. You get summary statistics only.

Rules:
- Describe what the numbers show, plainly and kindly, for a parent. Short sentences. mmol/L units.
- Never give or suggest insulin doses, carb ratios, correction factors, targets or any change to treatment. Never say how many units to give.
- If meals of one kind often end well above or below where they started 3 hours later, or lows or long highs are frequent, set discussWithTeam to one sentence suggesting they raise that pattern with his diabetes team. Otherwise null.
- Compare this week with last week when both have data. Don't invent anything not in the numbers; if data is thin, say so.
- headline: one sentence, at most 90 characters. points: up to 3, each at most 160 characters.`;

const BLOCK_NAMES = ['Night (00–06)', 'Morning (06–12)', 'Afternoon (12–18)', 'Evening (18–24)'];

// ISO week like 2026-W45.
export function isoWeek(ms) {
  const sa = new Date(ms + 2 * 3600000); // SA time
  const d = new Date(Date.UTC(sa.getUTCFullYear(), sa.getUTCMonth(), sa.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // the Thursday of this week
  const week = Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weekStats(days) {
  if (!days.length) return null;
  const blocks = combineBlocks(days);
  const n = blocks.reduce((a, b) => a + b.n, 0);
  const pct = [0, 1, 2, 3].map((j) => (n ? Math.round(blocks.reduce((a, b) => a + (b.pct[j] * b.n) / 100, 0) / n * 1000) / 10 : 0));
  return {
    daysWithReadings: days.length,
    percentOfTime: { belowLow: pct[0], inRange4to10: pct[1], from10to14: pct[2], above14: pct[3] },
    byTimeOfDay: blocks.map((b, i) => ({ block: BLOCK_NAMES[i], inRange: b.pct[1], above14: b.pct[3], belowLow: b.pct[0], mean: b.mean })),
  };
}

// The numbers Claude sees. Exported so tests can check nothing raw goes out.
export async function summaryInput(env, now = Date.now()) {
  const days = await readDays(env, 14, now);
  const cut = new Date(now + 2 * 3600000 - 8 * 86400000).toISOString().slice(0, 10);
  const thisWeek = days.filter((d) => d.date > cut);
  const lastWeek = days.filter((d) => d.date <= cut);
  const rs = thisWeek.flatMap((d) => d.responses);
  const lows = rs.filter((r) => r.kind === 'low-treatment');
  const corrections = rs.filter((r) => r.kind === 'correction');
  const meals = mealTypeStats(rs);
  return {
    thisWeek: weekStats(thisWeek),
    lastWeek: weekStats(lastWeek),
    mealsThisWeek: Object.fromEntries(Object.entries(meals).map(([k, m]) => [k, { meals: m.n, medianChangeAfter3h: m.end, medianRise: m.peak, wentLow: m.lows }])),
    lowTreatmentsThisWeek: { lows: lows.length, backAbove4At15min: lows.filter((r) => r.recovered15).length, neededSecond15g: lows.filter((r) => r.repeats > 0).length },
    correctionsThisWeek: { corrections: corrections.length, wentLow: corrections.filter((r) => r.wentLow).length },
  };
}

export async function writeSummary(env, now = Date.now()) {
  const input = await summaryInput(env, now);
  if (!input.thisWeek || input.thisWeek.daysWithReadings < 3) return { error: 'summary_needs_data' };
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_WORKSPACE_ID && { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } }),
  });
  const message = await client.beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 1500,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(SummarySchema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: `This week's numbers (last 7 days), with the week before for comparison:\n${JSON.stringify(input)}` }],
  });
  const out = message.parsed_output;
  if (message.stop_reason === 'refusal' || !out) return { error: 'summary_unavailable' };
  return {
    summary: {
      headline: out.headline.slice(0, 120),
      points: out.points.slice(0, 3).map((p) => p.slice(0, 200)),
      discussWithTeam: out.discussWithTeam ? out.discussWithTeam.slice(0, 200) : null,
      week: isoWeek(now),
      createdAt: new Date(now).toISOString(),
    },
  };
}

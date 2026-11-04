// Reads the nutrition table in a photo of food packaging with Claude, and returns
// the printed numbers. It never estimates: anything unreadable comes back null.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const LabelSchema = z.object({
  is_nutrition_label: z.boolean(),
  product_name: z.string(),
  brand: z.string(),
  carbs_per_100g: z.number().nullable(),
  carbs_per_serving: z.number().nullable(),
  serving_size_label: z.string().nullable(),
  serving_size_grams: z.number().nullable(),
  carbs_excludes_fibre: z.boolean().nullable(),
  fibre_per_100g: z.number().nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
  notes: z.string(),
});

const SYSTEM = `You read nutrition information tables from photos of food packaging for a carb-counting app used by the family of a child with type 1 diabetes. The numbers you return are used to work out insulin doses, so copy them exactly as printed.

Rules:
- Only report numbers that are printed and legible in the photo. Never estimate, calculate or fill in a value from general knowledge. If a value isn't printed or can't be read clearly, return null and say why in notes.
- carbs_per_100g and carbs_per_serving come from the carbohydrate row of the table (per 100 g or 100 ml, and per serving). Use grams.
- South African and European labels usually print "Carbohydrate" or "Glycaemic carbohydrate", which already excludes fibre: set carbs_excludes_fibre to true. If the label prints "Total carbohydrate" that includes dietary fibre (US style), set it to false and report fibre_per_100g if printed. If you can't tell, null.
- serving_size_label is the serving as printed (for example "2 biscuits (30 g)" or "1 cup (250 ml)"); serving_size_grams is its weight in grams if printed (treat ml as grams for drinks and say so in notes).
- product_name and brand come from the packaging if visible, otherwise empty strings.
- If the photo isn't a nutrition table, set is_nutrition_label to false and explain in notes.
- confidence is how sure you are the carbohydrate numbers are read correctly; use low for blur, glare, cut-off columns or any doubt.
- Keep notes short and plain, written for a parent.`;

export async function readLabel(env, { image, mediaType }) {
  // Organisation-level keys must name a workspace on each request; workspace keys don't need it.
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_WORKSPACE_ID && { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } }),
  });
  const message = await client.beta.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    // If the model declines, the API retries the same request on a fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(LabelSchema) },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: 'Read the nutrition table on this packet.' },
      ],
    }],
  });
  if (message.stop_reason === 'refusal') throw Object.assign(new Error('The label reader declined this photo.'), { code: 'label_refused' });
  if (message.stop_reason === 'max_tokens' || !message.parsed_output) throw Object.assign(new Error('The label reader gave an incomplete answer.'), { code: 'label_unreadable' });
  return message.parsed_output;
}

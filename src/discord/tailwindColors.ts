// Tailwind CSS v3.4.17's 500 palette, in its published order.
// Labels intentionally omit the shade number.
// https://v3.tailwindcss.com/docs/customizing-colors
export const TAILWIND_500_COLORS = {
  Slate: 0x64748b,
  Gray: 0x6b7280,
  Zinc: 0x71717a,
  Neutral: 0x737373,
  Stone: 0x78716c,
  Red: 0xef4444,
  Orange: 0xf97316,
  Amber: 0xf59e0b,
  Yellow: 0xeab308,
  Lime: 0x84cc16,
  Green: 0x22c55e,
  Emerald: 0x10b981,
  Teal: 0x14b8a6,
  Cyan: 0x06b6d4,
  Sky: 0x0ea5e9,
  Blue: 0x3b82f6,
  Indigo: 0x6366f1,
  Violet: 0x8b5cf6,
  Purple: 0xa855f7,
  Fuchsia: 0xd946ef,
  Pink: 0xec4899,
  Rose: 0xf43f5e
} as const;

const namedColors = Object.entries(TAILWIND_500_COLORS);

export function resolveMessageColor(input: string): number | undefined {
  const value = input.trim().toLowerCase();
  const named = namedColors.find(([name]) => name.toLowerCase() === value);
  if (named) return named[1];
  const hex = /^#?([0-9a-f]{6})$/.exec(value);
  return hex ? Number.parseInt(hex[1], 16) : undefined;
}

export function messageColorChoices(input: string): Array<{ name: string; value: string }> {
  const query = input.trim().toLowerCase();
  const choices: Array<{ name: string; value: string }> = namedColors
    .filter(([name]) => name.toLowerCase().includes(query))
    .map(([name]) => ({ name, value: name }));
  if (/^#?[0-9a-f]{6}$/i.test(query)) {
    const hex = `#${query.replace(/^#/, "").toUpperCase()}`;
    choices.push({ name: hex, value: hex });
  }
  return choices;
}

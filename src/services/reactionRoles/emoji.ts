import type { ApplicationEmoji, GuildEmoji, ReactionEmoji } from "discord.js";

export interface ParsedReactionEmoji {
  emojiKey: string;
  displayValue: string;
  customEmojiId?: string;
}

const CUSTOM_EMOJI_PATTERN = /^<(a?):([A-Za-z0-9_]{2,32}):(\d+)>$/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function parseReactionEmojiInput(input: string): ParsedReactionEmoji | undefined {
  const value = input.trim();
  const custom = value.match(CUSTOM_EMOJI_PATTERN);
  if (custom) {
    return {
      emojiKey: `custom:${custom[3]}`,
      displayValue: `<${custom[1] ? "a" : ""}:${custom[2]}:${custom[3]}>`,
      customEmojiId: custom[3]
    };
  }

  const normalized = value.normalize("NFC");
  const graphemes = [...graphemeSegmenter.segment(normalized)];
  if (
    graphemes.length !== 1
    || /\s/u.test(normalized)
    || !/\p{Emoji}/u.test(normalized)
  ) {
    return undefined;
  }

  return {
    emojiKey: `unicode:${normalized}`,
    displayValue: normalized
  };
}

export function canonicalReactionEmojiKey(
  emoji: GuildEmoji | ReactionEmoji | ApplicationEmoji
): string | undefined {
  if (emoji.id) {
    return `custom:${emoji.id}`;
  }
  if (!emoji.name) {
    return undefined;
  }
  return `unicode:${emoji.name.normalize("NFC")}`;
}

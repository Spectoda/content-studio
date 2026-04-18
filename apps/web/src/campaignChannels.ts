/**
 * Channel catalogue for Content Studio campaigns.
 *
 * Channels describe where a campaign output will land (LinkedIn, newsletter,
 * blog, …). Each channel has display metadata plus a content brief template
 * used to seed the per-channel AI prompt.
 */

export const CAMPAIGN_CHANNELS = [
  {
    id: "linkedin",
    label: "LinkedIn",
    format: "Short-form business social post",
    targetLength: "120–180 words",
    tone: "Professional, direct, result oriented.",
    tip: "Lead with the concrete customer outcome, keep paragraphs short, finish with a gentle CTA.",
  },
  {
    id: "newsletter",
    label: "Newsletter",
    format: "Email newsletter segment",
    targetLength: "250–400 words",
    tone: "Warm but informative; addresses the reader as 'you'.",
    tip: "Open with one compelling sentence, then 2–3 short sections. End with a single clear action link.",
  },
  {
    id: "blog",
    label: "Blog",
    format: "Medium-depth blog article",
    targetLength: "600–900 words",
    tone: "Editorial, confident, built on proof points.",
    tip: "Use an intro hook, 3–4 subheadings, concrete examples, and a short wrap-up paragraph.",
  },
  {
    id: "facebook",
    label: "Facebook",
    format: "Casual social post",
    targetLength: "80–140 words",
    tone: "Approachable, community friendly, light on jargon.",
    tip: "Start with the hook, keep sentences short, end with a question or invitation.",
  },
  {
    id: "instagram",
    label: "Instagram",
    format: "Instagram caption",
    targetLength: "60–120 words",
    tone: "Visual-first, enthusiastic, lifestyle oriented.",
    tip: "Grab attention in the first line, use line breaks, finish with 3–6 relevant hashtags.",
  },
  {
    id: "graphic",
    label: "Visual brief",
    format: "Brief for a designer / graphic output",
    targetLength: "120–200 words",
    tone: "Directive, structured; includes art direction notes.",
    tip: "Describe the message, layout idea, key visual, mood, and callouts the designer should produce.",
  },
] as const;

export type ChannelConfig = (typeof CAMPAIGN_CHANNELS)[number];
export type ChannelId = ChannelConfig["id"];

export const CAMPAIGN_CHANNEL_IDS: ChannelId[] = CAMPAIGN_CHANNELS.map((channel) => channel.id);

export function getChannelConfig(channelId: string): ChannelConfig | undefined {
  return CAMPAIGN_CHANNELS.find((channel) => channel.id === channelId);
}

export function getChannelLabel(channelId: string): string {
  return getChannelConfig(channelId)?.label ?? channelId;
}

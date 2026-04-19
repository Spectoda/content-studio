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
    format: "Krátký byznys příspěvek na sociální síť",
    targetLength: "120–180 slov",
    tone: "Profesionální, přímý, orientovaný na výsledek.",
    tip: "Začni konkrétním výsledkem pro zákazníka, drž krátké odstavce, zakonči jemnou CTA.",
  },
  {
    id: "newsletter",
    label: "Newsletter",
    format: "Segment e-mailového newsletteru",
    targetLength: "250–400 slov",
    tone: "Vřelý, ale informativní; oslovuje čtenáře přímo (tykání nebo vykání dle briefu).",
    tip: "Otevři jednou silnou větou, pak 2–3 krátké sekce. Zakonči jedním jasným odkazem k akci.",
  },
  {
    id: "blog",
    label: "Blog",
    format: "Blog článek střední hloubky",
    targetLength: "600–900 slov",
    tone: "Editorial, sebevědomý, postavený na důkazech.",
    tip: "Začni hookem v úvodu, použij 3–4 podnadpisy, konkrétní příklady a krátký závěrečný odstavec.",
  },
  {
    id: "facebook",
    label: "Facebook",
    format: "Neformální příspěvek na sociální síť",
    targetLength: "80–140 slov",
    tone: "Přístupný, komunitní, bez zbytečného žargonu.",
    tip: "Začni hookem, drž krátké věty, zakonči otázkou nebo pozváním.",
  },
  {
    id: "instagram",
    label: "Instagram",
    format: "Popisek k Instagram postu",
    targetLength: "60–120 slov",
    tone: "Vizuální, nadšený, lifestylový.",
    tip: "Získej pozornost v první větě, dělej odstavce, zakonči 3–6 relevantními hashtagy.",
  },
  {
    id: "graphic",
    label: "Vizuální brief",
    format: "Brief pro designera / grafický výstup",
    targetLength: "120–200 slov",
    tone: "Direktivní, strukturovaný; obsahuje poznámky k art direction.",
    tip: "Popiš sdělení, nápad na layout, klíčový vizuál, náladu a prvky, které má designer vytvořit.",
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

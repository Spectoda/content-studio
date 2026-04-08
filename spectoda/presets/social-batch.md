# Social Media Batch

## Brief Template

Generate a batch of social media posts for multiple channels from a single topic or article.

**Source topic/article:** [topic or slug of existing article]
**Channels to generate:**

- [ ] LinkedIn post
- [ ] Facebook post
- [ ] Instagram caption
- [ ] Newsletter teaser

## Guidelines

- Adapt the same core message for each channel's format and audience
- LinkedIn: B2B professional, insight-driven (max 1300 chars)
- Facebook: Casual professional, visual storytelling focus (max 500 chars)
- Instagram: Visual-first, atmosphere and impact (max 2200 chars, hashtags)
- Newsletter teaser: Brief hook that drives to full content (max 200 chars)
- Maintain consistent brand voice across all channels
- Each post should stand on its own — don't assume readers see other channels

## Channel Settings

```json
{
  "channels": ["linkedin", "facebook", "instagram", "newsletter"],
  "status": "draft"
}
```

## Process

1. Read the source article or topic brief
2. Read relevant tone guides (brand-voice, linkedin-patterns)
3. Generate drafts for each selected channel
4. Save each draft as a separate article under its channel category
5. Set metadata with appropriate channels and tags

## Tone Reference

Read `brand-voice`, `linkedin-patterns`, and channel-specific tone guides.

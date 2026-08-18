---
version: alpha
name: Shopifi Inspired
website: "https://www.shopify.com"
description: An inspired interpretation of Shopifi's design language — a cinematic commerce platform that runs two parallel design tracks. The marketing-hero and product-narrative pages live on near-black canvases with full-bleed photography of merchants, giant Neue Haas Grotesk display type at thin weights, and a single black-pill CTA stroked in white. The transactional pages (pricing, signup, dashboards) flip to a cream-mint canvas with pastel aloe and pistachio greens, the same pill button vocabulary, and Inter for UI body. The two tracks share typographic DNA but diverge sharply in canvas polarity — and that choice is the brand.

seo:
  title: "Shopify Design System for React — Neue Haas Grotesk 330, Aloe (#c1fbd4), 20 components"
  metaDescription: "Shopify's two-track design system as a DESIGN.md file. Black #000000 and cream #fbfbf5 canvases, aloe #c1fbd4 accent, NHG 330, 20 components. For React and AI."
  highlights:
    - "Two-canvas system — pure black #000000 for cinematic marketing, white #ffffff and cream #fbfbf5 for transactional surfaces, never blended"
    - "Thin-weight display type — Neue Haas Grotesk Display at weight 330 for every headline, including the 96px hero with 2.4px positive tracking"
    - "Pill-only button shape — every CTA uses rounded 9999px geometry across both tracks; rounded rectangles do not exist for buttons"
    - "Mint accents scoped to light — aloe #c1fbd4 and pistachio #d4f9e0 appear only on transactional pages, never on the cinematic black hero"
    - "Universal ss03 stylistic set — the OpenType feature is enabled across NHG, Inter, and ui-monospace as a character-level brand signature"
  tags:
    - "E-commerce & Retail"
  lastUpdated: "2026-05-12"
  author:
    name: "Dov Azencot"
    url: "https://x.com/dovazencot"
  opening: |
    Shopify's public design language reads like two design systems sharing one wordmark. The marketing-hero and product-narrative pages live on a pure-black canvas (#000000) with full-bleed merchant photography, giant Neue Haas Grotesk Display headlines at weight 330, and a single white-stroked black-pill CTA per band. The transactional pages — pricing, signup, dashboards — flip to white #ffffff and an off-white cream #fbfbf5, with the same pill button vocabulary in inverse polarity and pastel mint #c1fbd4 and pistachio #d4f9e0 accents reserved exclusively for this lighter track. The two surfaces never blend. That polarity split is the brand's loudest design decision, more identifying than any single color or shape.

    This page packages the full spec into one DESIGN.md file built on the Google Labs spec. Inside: 19 color tokens grouped into brand accents, surface ladders, shade scales, and text tones; 15 typography tokens across Neue Haas Grotesk Display (display, headlines), Inter Variable (UI body, captions), and ui-monospace (code); 6 corner radius values topped by the 9999px pill that every button uses; 8 spacing tokens on an 8px base scale; and 20 components covering buttons, pricing cards, cinematic photo frames, mint pills, light and dark nav bars, and dual-canvas footers.

    Feed this file to Claude, Cursor, or GitHub Copilot and the agent produces React components that respect the two-canvas split, the thin 330 display weight, and the pill-only button shape — not a generic e-commerce theme. Or reference the tokens directly: every hex, font, radius, and spacing value lives as a quoted string you can paste into Tailwind config or CSS variables. The system is worth studying precisely because of its discipline: one shape for buttons, one weight for display, one canvas per page intent. Shopify uses constraint as a brand voice.
  related:
    - href: "https://github.com/google-labs-code/design.md"
      title: "The DESIGN.md specification"
      description: "Google Labs' open spec for machine-readable design system files — the format this page is built on."
    - href: "/design"
      title: "Browse all design systems"
      description: "The full directory of DESIGN.md files on shadcn.io, with live mockups for each."
    - href: "/blocks"
      title: "React blocks for shadcn/ui"
      description: "Production-ready hero, pricing, CTA, and dashboard sections built with the same Tailwind + shadcn primitives."
  questions:
    - id: "primary-color"
      title: "What is Shopify's primary brand color?"
      answer: "Shopify's brand operates on a polarity rather than a single accent. The cinematic marketing track uses pure black #000000 as canvas with white #ffffff type and white-stroked outline pills. The transactional track flips to white #ffffff and cream #fbfbf5 canvas with black #000000 ink and a featured aloe #c1fbd4 mint pill on pricing pages. Pistachio #d4f9e0 appears as a band fill on the light track. There is no purple, blue, or gradient in the system — green is the only chromatic accent and it is scoped strictly to the light surfaces."
    - id: "typography"
      title: "What typography does Shopify use, and what should I use if Neue Haas Grotesk isn't available?"
      answer: "Shopify runs Neue Haas Grotesk Display at weight 330 for every display and headline role — the thinness is the brand's typographic signature, from the 96px hero down to 18px eyebrows. UI body, button labels, and captions use Inter Variable at weights 420–550. Code blocks use ui-monospace, the system mono. If Neue Haas Grotesk is unavailable, Helvetica Now Display at light weights or Inter Display at light weights are the closest substitutes — never default Helvetica Neue, which is too heavy. The OpenType ss03 stylistic set is enabled across all three families as a character-level unifier."
    - id: "dual-canvas"
      title: "Why does Shopify run two parallel canvas tracks instead of one design system?"
      answer: "The split lets each page do its job. The cinematic black track treats marketing surfaces like a high-end print spread — full-bleed merchant photography, 128–192px of vertical air between bands, and one CTA per scroll. The light track collapses to 48–64px section padding because pricing, signup, and dashboard users are scanning and comparing. Mixing the two would dilute both: cinematic black with dense pricing tables feels overwhelming, and white with edge-bleeding merchant photos feels generic. The two whitespace philosophies are part of the brand voice."
    - id: "pill-buttons"
      title: "Why are all Shopify buttons pill-shaped?"
      answer: "The 9999px pill radius is the only button shape in the entire system across both canvas tracks. It maintains identity when everything else (canvas, text color, border weight) flips between cinematic and transactional contexts. The black canvas gets a transparent pill with a 2px white stroke; the light canvas gets a solid black pill with white text or an aloe #c1fbd4 mint pill for the featured pricing tier. Pressed state lifts to shade-70 #3f3f46. The shape is non-negotiable — new variants change fill, border, or canvas, never the radius."
    - id: "use-in-project"
      title: "Can I use this DESIGN.md to build my own React e-commerce site?"
      answer: "Yes — the file feeds into Claude, Cursor, or any AI tool that reads structured design tokens. The agent will reproduce Shopify's discipline: two-canvas split, thin 330 display weight, pill-only buttons, mint scoped to light surfaces. You can also paste the tokens directly into Tailwind config or CSS variables — every color hex, font stack, radius value, and component definition lives as a quoted YAML string. The 20 components map cleanly onto shadcn/ui primitives: pill buttons swap shadcn Button radius to 9999px, pricing cards use Card with rounded-lg and 32px padding, and the dual nav bars are straightforward header components."
    - id: "known-gaps"
      title: "What's missing from this DESIGN.md spec?"
      answer: "Several things, captured at the bottom of the file: hover-state colors for pill buttons (the system lifts to shade-70 #3f3f46 on press but hover styling is more subtle), loading skeletons, the dashboard analytics chart palette, full input error-state combinations, the in-product Polaris admin design system (a separate sub-system used inside the merchant admin), and motion specifications for the cinematic photography crossfades. The spec captures the marketing site and pricing flow — roughly the surfaces a visitor sees before signing up."

colors:
  primary: "#000000"
  ink: "#000000"
  on-primary: "#ffffff"
  on-dark: "#ffffff"
  canvas-night: "#000000"
  canvas-night-elevated: "#0a0a0a"
  canvas-light: "#ffffff"
  canvas-cream: "#fbfbf5"
  surface-elevated-dark: "#1e2c31"
  shade-30: "#d4d4d8"
  shade-40: "#a1a1aa"
  shade-50: "#71717a"
  shade-60: "#52525b"
  shade-70: "#3f3f46"
  hairline-light: "#e4e4e7"
  hairline-dark: "#1e2c31"
  aloe-10: "#c1fbd4"
  pistachio-10: "#d4f9e0"
  link-cool-1: "#9dabad"
  link-cool-2: "#9797a2"
  link-cool-3: "#bdbdca"
  link-mint: "#99b3ad"

typography:
  display-xxl:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 96px
    fontWeight: 330
    lineHeight: 1.0
    letterSpacing: 2.4px
    fontFeature: ss03
  display-xl:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 70px
    fontWeight: 330
    lineHeight: 1.0
    letterSpacing: 0
    fontFeature: ss03
  display-lg:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 55px
    fontWeight: 330
    lineHeight: 1.16
    letterSpacing: 0
    fontFeature: ss03
  display-md:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 48px
    fontWeight: 330
    lineHeight: 1.14
    letterSpacing: 0
    fontFeature: ss03
  heading-xl:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.28
    letterSpacing: 0.42px
    fontFeature: ss03
  heading-lg:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.14
    letterSpacing: 0.36px
    fontFeature: ss03
  heading-md:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.3px
    fontFeature: ss03
  heading-sm:
    fontFamily: "NeueHaasGrotesk Display, Helvetica, Arial, sans-serif"
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: 0.72px
    fontFeature: ss03
  body-lg:
    fontFamily: "Inter Variable, Inter, Helvetica, Arial, sans-serif"
    fontSize: 18px
    fontWeight: 550
    lineHeight: 1.56
    letterSpacing: 0
    fontFeature: ss03
  body-md:
    fontFamily: "Inter Variable, Inter, Helvetica, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 420
    lineHeight: 1.5
    letterSpacing: 0
    fontFeature: ss03
  body-strong:
    fontFamily: "Inter Variable, Inter, Helvetica, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 550
    lineHeight: 1.5
    letterSpacing: 0
    fontFeature: ss03
  caption:
    fontFamily: "Inter Variable, Inter, Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.49
    letterSpacing: 0.28px
    fontFeature: ss03
  micro:
    fontFamily: "Inter Variable, Inter, Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: -0.13px
    fontFeature: ss03
  eyebrow-cap:
    fontFamily: "Inter Variable, Inter, Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: 0.72px
    fontFeature: ss03
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
    fontFeature: ss03

rounded:
  xs: 4px
  sm: 5px
  md: 8px
  lg: 12px
  xl: 20px
  pill: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  huge: 64px

components:
  button-primary-pill:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.pill}"
    padding: 12px 24px
  button-primary-pill-pressed:
    backgroundColor: "{colors.shade-70}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.pill}"
    padding: 12px 24px
  button-outline-on-dark:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.pill}"
    padding: 12px 26px
  button-outline-on-light:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.pill}"
    padding: 12px 24px
  button-aloe-pill:
    backgroundColor: "{colors.aloe-10}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.pill}"
    padding: 12px 24px
  text-input:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 10px 12px
  card-pricing:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 32px
  card-pricing-featured:
    backgroundColor: "{colors.aloe-10}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 32px
  card-feature-cinematic:
    backgroundColor: "{colors.canvas-night-elevated}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.lg}"
    padding: 32px
  card-pistachio-band:
    backgroundColor: "{colors.pistachio-10}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 32px
  card-photo-frame:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: 0px
  pill-tag-mint:
    backgroundColor: "{colors.aloe-10}"
    textColor: "{colors.ink}"
    typography: "{typography.eyebrow-cap}"
    rounded: "{rounded.pill}"
    padding: 4px 12px
  pill-tag-shade:
    backgroundColor: "{colors.shade-30}"
    textColor: "{colors.ink}"
    typography: "{typography.eyebrow-cap}"
    rounded: "{rounded.pill}"
    padding: 4px 12px
  nav-bar-light:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: 16px 24px
  nav-bar-dark:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: 16px 24px
  link-on-dark:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: 0px
  footer-dark:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: 64px 24px
  footer-light:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: 64px 24px
---

## Overview

Shopify's public design language runs two parallel tracks that share typographic DNA and a single button vocabulary, but diverge sharply in canvas polarity. The marketing track lives on `{colors.canvas-night}` (#000000) — full-bleed merchant photography, giant `{typography.display-xxl}` headlines in Neue Haas Grotesk Display set at weight 330 (a thin, almost editorial cut), and a single CTA: a white-stroked black pill rendered as `button-outline-on-dark`. The pages read like a high-end print spread: lots of black, lots of negative space, photography that doesn't compete with text, and one and only one action per band.

The transactional track flips to `{colors.canvas-light}` (#ffffff) and `{colors.canvas-cream}` (#fbfbf5 — an off-white that's barely warmer than pure white). Pricing tiers, comparison tables, and signup flows sit on this lighter canvas, with the same pill button system in inverse polarity (a solid black pill with white text, or an aloe `{colors.aloe-10}` #c1fbd4 pill for the featured "Start free trial" tier). The mint accents `{colors.aloe-10}` (#c1fbd4) and `{colors.pistachio-10}` (#d4f9e0) appear exclusively on the light track — never on the cinematic dark hero pages.

Typography splits across three families. **Neue Haas Grotesk Display** at thin weights 330–500 handles every display, headline, and editorial moment — the brand's identity is that thin display cut. **Inter Variable** at weights 420–550 handles every UI body, button label, caption, and form field — utility text that doesn't fight the display. **ui-monospace** appears only in code blocks and rare technical eyebrows. The OpenType `ss03` stylistic set is enabled across all three families — a character-level brand signature applied universally.

**Key Characteristics:**
- Two-canvas system: `{colors.canvas-night}` (#000000) for cinematic marketing, `{colors.canvas-light}` (#ffffff) and `{colors.canvas-cream}` (#fbfbf5) for transactional surfaces — never blended on the same page.
- Pill-shape (`{rounded.pill}` 9999px) is the only button shape across both tracks; rounded rectangles do not exist for buttons.
- Thin-weight 330 display typography is the signature; `{typography.display-xxl}` at 96px / weight 330 is the brand's loudest visual.
- Aloe `{colors.aloe-10}` (#c1fbd4) and pistachio `{colors.pistachio-10}` (#d4f9e0) are reserved for the light track — they signal commerce, growth, transactional success.
- Photography is full-bleed, edge-to-edge, never inset in cards on the cinematic track; merchants and storefront imagery do the heavy lifting that gradients and illustrations would do elsewhere.
- The OpenType `ss03` stylistic set is enabled across every text role — a character-level unifier that tracks across both canvas polarities.
- Tight letter-spacing on display sizes (2.4px positive tracking on 96px display) gives the thin weight extra optical air.

## Known Gaps

- **Hover-state colors:** the press state lifts to `{colors.shade-70}` (#3f3f46), but hover styling between idle and press is more subtle and not reliably extracted.
- **Loading states / skeleton screens:** not captured on the surveyed surfaces.
- **Polaris admin system:** Shopify's in-product merchant admin uses a separate design system (Polaris) with its own tokens and component library; not represented here.
- **Dashboard chart palette:** analytics widgets inside the merchant dashboard use chart colors not visible on the marketing or pricing pages.
- **Form input error states:** error styling for the `{component.text-input}` token (border treatment, helper text color, icon) was not visible on the captured surfaces.
- **Motion specifications:** the cinematic photography crossfades and pill-button press transitions have timing curves that weren't captured in static extraction.

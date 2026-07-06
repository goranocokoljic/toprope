# Handoff: toprope Color System

## Overview
A single color palette for both the toprope **marketing site** and the **product app**, so a button, a badge, or a background reads as the same brand in either place. This package is the source of truth for color; it does not cover typography, spacing, or components beyond how color applies to them.

## About the Design Files
`toprope Colors.html` (and the screenshots, if included) are **design references created in HTML** — a visual spec of the palette, not production code to copy. Implement the tokens in the app's existing environment: import `tokens.css` (CSS custom properties), `tokens.json` (any build system / design-token pipeline), or drop `tailwind.snippet.js` into `tailwind.config.js`. Use whichever matches the codebase; they encode identical values.

## Fidelity
**High-fidelity.** All hex values are final. Apply them exactly.

## The core idea (read this first)
The current app screenshot uses **cool** grays and an indigo accent; the site uses **warm** paper tones and orange. To unify them, three rules:

1. **Brand orange (`#F0561D`) is a single-primary accent.** One primary action per view (the main CTA), plus the anchor dot / brand mark. Never body text, never large fills, never more than one orange button on screen.
2. **Indigo (`#5B5BD6`) carries interactive UI state** — active nav item, links, selected rows, the sync/status dot, the `beta` badge. It's the app's working color and must not compete with the orange CTA.
3. **Neutrals are a warm-tinted gray ramp**, not cool slate. This is the change that makes the clean dashboard feel like the same product as the warm landing page. Replace existing cool grays (`#6b7280`, `#9ca3af`, `#e5e7eb`, etc.) with the `ink-*` ramp.

## Design Tokens

### Brand — primary (orange)
- `orange-600 #F0561D` — primary CTA, brand on light, anchor dot
- `orange-500 #FF6A2C` — hover; brand on dark surfaces
- `orange-700 #C7420F` — pressed; orange text on a tint background
- `orange-100 #FCE6DC` — tint background / highlight

### Secondary — indigo (interactive state)
- `indigo-600 #5B5BD6` — links, active state, sync dot
- `indigo-700 #4B4BC4` — hover; indigo text on tint
- `indigo-100 #E6E6FB` — active nav background, `beta` badge background
- `indigo-50  #F1F1FC` — row hover, subtle fill

### Accents (categorical — charts, the "two ends of the rope")
- `teal-600   #3A8E8E` / `teal-100 #E1EEEE` — "for leaders", data series A
- `violet-600 #7A68C8` / `violet-100 #EAE6F6` — "for developers", data series B

### Neutrals — warm gray ramp
- `ink-900 #1F1B16` — primary text; also the dark surface color
- `ink-700 #3B352D` — strong body text
- `ink-500 #5D554A` — secondary text
- `ink-400 #8A8175` — muted / placeholder text
- `ink-300 #B0A797` — disabled, uppercase section labels
- `ink-200 #CFC7B8` — control outlines (e.g. empty radios)
- `ink-100 #E7E1D6` — borders, dividers
- `ink-50  #F3EFE7` — hover surface
- `ink-0   #FCFAF6` — lightest raised fill

### Surfaces / backgrounds
- `canvas  #F7F5F0` — **app** dashboard background
- `paper   #F6F1E9` — **site** landing background
- `surface #FFFFFF` — cards, panels, nav rail
- `surface-dark #100F0E` — dark hero / footer sections

### Semantic (fixed meanings — also used as confidence tiers)
Each is an `fg` (line/icon/text) + `bg` (tint) pair:
- **positive** `#2F8F5B` / `#E4F1EA` — adoption up, high confidence
- **caution** `#C98A1E` / `#F7EDD9` — Waste, spend leaks, low confidence
- **negative** `#D64545` / `#FAE6E6` — Anomalies, drop-off, no data
- **info** `#5B5BD6` / `#E6E6FB` — Coaching, syncing, in progress

## Applying it to the app (screenshot-specific mapping)
Using the Organization Overview screen as the worked example:
- **Page background** → `canvas #F7F5F0`. **Nav rail + main card** → `surface #FFFFFF` with `ink-100` borders.
- **Active nav item ("Overview")** → background `indigo-100`, text `indigo-700`, weight 600. Inactive items → `ink-500`.
- **Section labels ("MANAGER", "ADMIN", "CONNECTORS", "SETUP")** → `ink-300`, uppercase, letter-spacing ~0.1em.
- **`beta` badge** → background `indigo-100`, text `indigo-700`.
- **Sync/status dot** → `indigo-600` with a 6px `indigo-100` halo (`box-shadow: 0 0 0 6px #E6E6FB`).
- **Title** → `ink-900`; **subtitle / helper copy** → `ink-500`.
- **Empty radio controls** → 2px `ink-200` ring.
- **Feature nav dots** (optional, to reinforce semantics): Waste → `caution-600`, Anomalies → `negative-600`, Coaching → `positive-600`.
- **Primary button ("Connect a tool")** → `orange-600` bg, white text, hover `orange-500`. This is the only orange on the screen.
- **Connector bullets (Copilot, Claude Code, …)** → neutral `ink-400`; switch to `positive-600` once a connector is actively syncing.

## Assets
- `assets/anchor-dot.svg` — orange anchor dot (favicon / brand mark), `#F0561D`.
- Logo wordmark not included here; it lives with the site files (`logo-on-light.svg` / `logo-on-dark.svg`).

## Files in this bundle
- `README.md` — this document
- `tokens.css` — CSS custom properties (`--tr-*`) with semantic aliases
- `tokens.json` — machine-readable tokens for a build pipeline
- `tailwind.snippet.js` — `theme.extend.colors` block for Tailwind
- `toprope Colors.html` — the visual spec (self-contained; open in any browser)

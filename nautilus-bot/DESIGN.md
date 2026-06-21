# Plainsong Design Context

> **Visuals (color, type, motif, motion) are governed by [STYLE.md](STYLE.md)** — the Plainsong
> brand bible translated for the app. This file governs register, interaction, state design, and
> release discipline, which all still hold. Where the two once overlapped on *looks*, STYLE.md wins.

## Register

Product UI. Design serves fast daily operation, clear trust signals, and low-friction recovery. The first screen should feel like an active control room for dictation and meetings, not a marketing page.

## Visual Direction

Plainsong is a **candle-lit scriptorium desk**: vellum/ink grounds, one gold accent, one rust rubric, no other hues (see [STYLE.md](STYLE.md) §0–1). It should feel composed, warm, and usable for long sessions — a control room, not a marketing page. Reserve burnished gold for the earned moment (the live "setting down" state, the one primary CTA); everything else stays quiet. Avoid the stoplight convention (no green/blue/amber status colors), decorative glass, glow-heavy surfaces, and card grids that repeat the same visual idea.

## Typography

Three self-hosted faces (see [STYLE.md](STYLE.md) §2): **Newsreader** (display serif — headings, wordmark, inked/transcript text, versals), **IBM Plex Mono** (rubrics, eyebrows, metadata, specs, keycaps, readouts — UPPERCASE, wide tracking, usually rust), and **IBM Plex Sans** (quiet running body). Body copy stays short and practical; section labels use the `.rubric` rubrication convention.

## Components

Use the existing shadcn setup first: Button, Badge, Card, Dialog, DropdownMenu, Input, Select, Switch, Tabs, Textarea, Tooltip, ScrollArea, Popover, and Command. Use semantic tokens and component variants before adding custom styling. Cards are for bounded tools, repeated records, and modal surfaces. Full page sections should use panels or layout rhythm, not nested cards.

## Interaction

Primary actions need clear affordance, keyboard reachability, focus visibility, and disabled or loading feedback when applicable. Icon buttons need accessible labels. Button icons should use the project icon library and shadcn icon conventions. Touch and pointer targets should remain comfortable even in dense settings views.

## Motion

Motion should be modest and functional. Use opacity and transform transitions between 150 and 300ms. Respect reduced motion. Do not animate layout properties. Avoid decorative motion on status surfaces where users are evaluating trust or failure.

## State Design

Status surfaces must make the current state, cause, and next action visible. Dictation delivery should show target app, route, insertion path, fallback reason, and repair action when available. Meeting capture should make consent, recording, processing, transcript freshness, export state, retention, and backup state unmistakable.

## Release Discipline

UI copy must describe what the app actually does. Don't make competitor-parity or capability claims the product can't back up. Prefer narrow, useful labels over broad confidence language.

# Plainsong Design Context

## Register

Product UI. Design serves fast daily operation, clear trust signals, and low-friction recovery. The first screen should feel like an active control room for dictation and meetings, not a marketing page.

## Visual Direction

Use a restrained dark desktop interface with warm tinted neutrals, quiet borders, focused panels, and one measured accent used for action or state. The app should feel composed, technical, and usable for long sessions. Avoid purple-blue gradient dominance, decorative glass, glow-heavy surfaces, large hero typography, and card grids that repeat the same visual idea.

## Typography

Use the current app font stack and keep it legible at desktop density. Headings should rely on weight, size, and spacing, not novelty display fonts. Body copy should stay short and practical. Labels use normal letter spacing unless a small uppercase status label is genuinely useful.

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

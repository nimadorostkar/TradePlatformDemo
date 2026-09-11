# ADR 0001 — Layout engine for the customisable workspace

Status: **Accepted** · Date: 2026-07-30

## Context

The terminal needs resizable/collapsible left, right, and bottom docks, widgets
that can be reordered within a region, moved between regions, and grouped into
tabs, plus saved layouts and a path to multi-chart. The chart is a TradingView
widget that owns an iframe.

Three options were considered against the real constraints.

## Options

### A. A docking library (`rc-dock`, `flexlayout-react`, `dockview`)

Gives tabbed docking, drag-to-move and float out of the box.

Costs measured against our constraints:

- **Iframe hostility.** All three unmount and remount panel contents when a tab
  is dragged or a group is re-parented. Remounting the chart panel destroys the
  TradingView iframe, which violates the hard requirement _"restore layout
  without reinitializing an unaffected TradingView chart"_. Working around it
  means portalling the chart out of the library's tree — at which point the
  library is no longer managing the thing that matters.
- **Weight.** `dockview` is ~120 kB min+gz; `flexlayout-react` ~60 kB. That is
  paid on top of the licensed TradingView bundle, which already dominates.
- **Styling.** Each ships an opinionated theme that has to be overridden to hit
  a dense broker-branded look, and their internal class names are not a
  stable API.

`dockview` has the best licence (MIT) and the most active maintenance of the
three; `rc-dock` is the least actively maintained.

### B. `react-resizable-panels` + our own widget placement

`react-resizable-panels` (MIT, ~9 kB min+gz, actively maintained, used widely)
solves exactly one problem well: accessible, keyboard-operable, persisted
resizing with correct ARIA separator semantics. It does not own our component
tree.

Widget→region assignment, ordering, and tab grouping become plain state in our
versioned workspace document. Moving a widget is a state edit, not a DOM
re-parent, so React reconciles panels in place and the chart's subtree is never
unmounted.

Reordering and cross-region moves use the native HTML5 drag-and-drop API plus a
keyboard command path (a "Move widget" action in the command palette), which is
what makes the docks operable without a mouse.

### C. Build a full docking engine

Rejected outright. Floating windows, drag ghosts, and drop-zone hit-testing are
weeks of work and a permanent maintenance liability, for behaviour the product
does not actually require.

## Decision

**Option B.** `react-resizable-panels` for resizing; workspace state for
placement, ordering, and tabs.

Decisive factor: it is the only option where a layout change cannot remount the
TradingView chart. The others each require fighting the library on precisely
the requirement that is hardest to satisfy and most expensive to get wrong.

## Consequences

- No floating/undocked widgets. Accepted — not a requirement, and the mobile
  and tablet experiences do not want them anyway.
- Drag-and-drop reordering is ours to maintain. Bounded: it is a list reorder
  plus a region drop target, both covered by tests.
- Multi-chart is a nested `PanelGroup` inside the centre region, so the one-,
  two-, three- and four-chart models are the same mechanism at a different
  depth.
- Panel sizes are percentages, which is what the persistence layer stores;
  restoring a layout on a different viewport size therefore behaves sensibly.

## Revisit if

Floating or tear-out windows become a real requirement, or a docking library
ships an API that guarantees content is not remounted across a move. At that
point `dockview` is the candidate to re-evaluate.

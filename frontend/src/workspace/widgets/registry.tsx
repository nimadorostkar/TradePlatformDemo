import { lazy } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  Calculator,
  CandlestickChart,
  Clock,
  FileText,
  History,
  Layers,
  ListOrdered,
  NotebookPen,
  Search,
  Star,
  Terminal,
  Wallet,
} from 'lucide-react';
import { createRegistry, type WidgetDefinition } from '../registry/types';

/**
 * The built-in widget registry.
 *
 * Every widget is lazily loaded, so opening the terminal does not pay for
 * panels the user has not placed.
 *
 * Capability gating is honest by design. A widget declares what it needs and
 * `WidgetHost` asks the gateway whether this deployment serves it; when the
 * answer is no, the panel says so and reports the gateway's own reason. An
 * empty DOM ladder or a fake alerts list would imply the feature works.
 */

const widgets: WidgetDefinition[] = [
  {
    id: 'watchlist',
    title: 'Watchlist',
    icon: ListOrdered,
    lazyComponent: lazy(() => import('@/features/watchlist/WatchlistWidget')),
    allowedRegions: ['left', 'right', 'bottom'],
    defaultRegion: 'left',
    minimumSize: 160,
    singleton: true,
    description: 'Track live bid/ask for your chosen symbols.',
  },
  {
    id: 'symbol-search',
    title: 'Symbol Search',
    shortTitle: 'Search',
    icon: Search,
    lazyComponent: lazy(() => import('@/features/watchlist/SymbolSearchWidget')),
    allowedRegions: ['left', 'right', 'bottom'],
    defaultRegion: 'left',
    minimumSize: 200,
    singleton: true,
    description: 'Find any tradable symbol on the server.',
  },
  {
    id: 'favorites',
    title: 'Favorites',
    icon: Star,
    lazyComponent: lazy(() => import('@/features/watchlist/FavoritesWidget')),
    allowedRegions: ['left', 'right'],
    defaultRegion: 'left',
    // MED-08: every dockable panel declares the height below which it is not
    // usable without scrolling — the audit measured Details and the DOM at
    // 120px, enough for a header and one row. The region layer already
    // scrolls the stack when the declared minimums cannot all fit.
    minimumSize: 160,
    singleton: true,
    description: 'Starred symbols and recently viewed instruments.',
  },
  {
    id: 'order-ticket',
    title: 'New Order',
    shortTitle: 'Order',
    icon: CandlestickChart,
    lazyComponent: lazy(() => import('@/features/order-ticket/OrderTicketWidget')),
    allowedRegions: ['right', 'left'],
    defaultRegion: 'right',
    minimumSize: 260,
    requiredCapability: 'trading',
    singleton: true,
    description: 'Place market and pending orders.',
  },
  {
    id: 'positions',
    title: 'Positions',
    icon: Layers,
    lazyComponent: lazy(() => import('@/features/positions/PositionsWidget')),
    allowedRegions: ['bottom', 'right'],
    defaultRegion: 'bottom',
    minimumSize: 180,
    singleton: true,
    description: 'Open positions with live profit and loss.',
  },
  {
    id: 'pending-orders',
    title: 'Pending Orders',
    shortTitle: 'Orders',
    icon: Clock,
    lazyComponent: lazy(() => import('@/features/pending-orders/PendingOrdersWidget')),
    allowedRegions: ['bottom', 'right'],
    defaultRegion: 'bottom',
    minimumSize: 180,
    singleton: true,
    description: 'Working limit and stop orders.',
  },
  {
    id: 'order-history',
    title: 'Order History',
    shortTitle: 'History',
    icon: History,
    lazyComponent: lazy(() => import('@/features/history/OrderHistoryWidget')),
    allowedRegions: ['bottom'],
    defaultRegion: 'bottom',
    minimumSize: 200,
    requiredCapability: 'history',
    singleton: true,
    description: 'Closed positions with realised P/L, and the full order history.',
  },
  {
    id: 'deals',
    title: 'Deals',
    icon: FileText,
    lazyComponent: lazy(() => import('@/features/history/DealsWidget')),
    allowedRegions: ['bottom'],
    defaultRegion: 'bottom',
    minimumSize: 200,
    requiredCapability: 'history',
    singleton: true,
    description: 'Every deal, including balance and credit entries.',
  },
  {
    id: 'account-summary',
    title: 'Account',
    icon: Wallet,
    lazyComponent: lazy(() => import('@/features/account-summary/AccountSummaryWidget')),
    allowedRegions: ['bottom', 'right', 'left'],
    defaultRegion: 'bottom',
    minimumSize: 190,
    singleton: true,
    description: 'Balance, equity, margin, and margin level.',
  },
  {
    id: 'symbol-details',
    title: 'Symbol Details',
    shortTitle: 'Details',
    icon: BarChart3,
    lazyComponent: lazy(() => import('@/features/symbol-details/SymbolDetailsWidget')),
    allowedRegions: ['right', 'left', 'bottom'],
    defaultRegion: 'right',
    minimumSize: 200,
    singleton: true,
    description: 'Contract specification for the active symbol.',
  },
  {
    id: 'risk-calculator',
    title: 'Risk Calculator',
    shortTitle: 'Risk',
    icon: Calculator,
    lazyComponent: lazy(() => import('@/features/risk-calculator/RiskCalculatorWidget')),
    allowedRegions: ['right', 'left', 'bottom'],
    defaultRegion: 'right',
    // Position sizing needs a tick size AND a tick value. MT5 returns both as 0
    // for every symbol on this feed and the mapper normalises a non-positive
    // tick to null, so this panel rendered an explanation of its own failure on
    // every instrument tried — while looking like a working feature. Gated like
    // Market Depth: absent when the gateway cannot supply the inputs, rather
    // than present and permanently broken.
    requiredCapability: 'position-sizing',
    minimumSize: 240,
    singleton: true,
    description: 'Size a position from a risk percentage.',
  },
  {
    id: 'journal',
    title: 'Trading Journal',
    shortTitle: 'Journal',
    icon: NotebookPen,
    lazyComponent: lazy(() => import('@/features/journal/JournalWidget')),
    allowedRegions: ['bottom', 'right', 'left'],
    defaultRegion: 'bottom',
    minimumSize: 180,
    singleton: true,
    description: 'Notes on your trades, synced with your workspace.',
  },
  {
    id: 'system-messages',
    title: 'System Messages',
    shortTitle: 'System',
    icon: Terminal,
    lazyComponent: lazy(() => import('@/features/system-messages/SystemMessagesWidget')),
    allowedRegions: ['bottom'],
    defaultRegion: 'bottom',
    minimumSize: 160,
    singleton: true,
    description: 'Connection diagnostics and request traces.',
  },

  // ── capability-gated: no verified backend ────────────────────────────────
  // ── capability-gated: the gateway reports whether it serves these ────────
  {
    id: 'market-depth',
    title: 'Market Depth',
    shortTitle: 'DOM',
    icon: Activity,
    lazyComponent: lazy(() => import('@/features/market-depth/MarketDepthWidget')),
    allowedRegions: ['right', 'bottom'],
    defaultRegion: 'right',
    requiredCapability: 'market-depth',
    minimumSize: 240,
    singleton: true,
    description: 'Order book depth for the active symbol.',
  },
  {
    id: 'alerts',
    title: 'Price Alerts',
    shortTitle: 'Alerts',
    icon: Bell,
    lazyComponent: lazy(() => import('@/features/alerts/AlertsWidget')),
    allowedRegions: ['right', 'bottom'],
    defaultRegion: 'right',
    requiredCapability: 'price-alerts',
    minimumSize: 220,
    singleton: true,
    description: 'Server-side price alerts that outlive this tab.',
  },
];

export const widgetRegistry = createRegistry(widgets);

/** Widgets offered in the "add panel" menu for a given region. */
export function availableWidgetsFor(region: string): WidgetDefinition[] {
  return [...widgetRegistry.values()].filter(
    (widget) => !widget.systemWidget && widget.allowedRegions.includes(region as never),
  );
}

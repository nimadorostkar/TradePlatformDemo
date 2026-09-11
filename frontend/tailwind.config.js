/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Every colour resolves through a semantic CSS variable so a broker's
      // brand can be swapped at runtime without rebuilding. Feature components
      // must never reference a literal brand colour.
      colors: {
        bg: {
          primary: 'var(--background-primary)',
          secondary: 'var(--background-secondary)',
          tertiary: 'var(--background-tertiary)',
        },
        surface: {
          raised: 'var(--surface-raised)',
          overlay: 'var(--surface-overlay)',
        },
        border: {
          DEFAULT: 'var(--border-default)',
          strong: 'var(--border-strong)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        // Channel form, so an opacity modifier resolves: Tailwind can only
        // apply one where it can substitute <alpha-value> itself, and a plain
        // var() colour gives it nowhere to put the alpha — it drops the class
        // silently rather than failing the build.
        positive: 'rgb(var(--positive-rgb) / <alpha-value>)',
        negative: 'rgb(var(--negative-rgb) / <alpha-value>)',
        warning: 'rgb(var(--warning-rgb) / <alpha-value>)',
        info: 'rgb(var(--info-rgb) / <alpha-value>)',
        brand: {
          primary: 'rgb(var(--brand-primary-rgb) / <alpha-value>)',
          secondary: 'var(--brand-secondary)',
        },
        focus: 'var(--focus-ring)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        // A trading terminal is information-dense; the base scale is tighter
        // than a marketing site's.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.05rem' }],
        sm: ['0.8125rem', { lineHeight: '1.15rem' }],
        base: ['0.875rem', { lineHeight: '1.25rem' }],
      },
      spacing: {
        'row-compact': '1.5rem',
        'row-normal': '1.875rem',
        'row-relaxed': '2.25rem',
      },
      keyframes: {
        'flash-up': {
          '0%': { backgroundColor: 'var(--positive-flash)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-down': {
          '0%': { backgroundColor: 'var(--negative-flash)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: {
        'flash-up': 'flash-up 480ms ease-out',
        'flash-down': 'flash-down 480ms ease-out',
      },
    },
  },
  plugins: [],
};

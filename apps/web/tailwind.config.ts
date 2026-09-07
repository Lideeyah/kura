import type { Config } from 'tailwindcss';

/**
 * KURA design tokens.
 *
 * The palette is deliberately narrow: three neutral surfaces, two border weights, two
 * text weights, and exactly three signal accents. Accents carry meaning and nothing
 * else — emerald is "healthy / approved / verified", amber is "degraded but inside
 * budget", rose is "halted / tripped / tampered". Nothing decorative is ever tinted.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#08090C',
        surface: '#0F1117',
        'surface-subtle': '#161922',
        border: '#1E222D',
        'border-bright': '#2D3343',
        'text-primary': '#F3F4F6',
        'text-muted': '#6B7280',
        emerald: { DEFAULT: '#10B981' },
        amber: { DEFAULT: '#F59E0B' },
        rose: { DEFAULT: '#F43F5E' },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      letterSpacing: {
        tight: '-0.02em',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      keyframes: {
        'drawer-in': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'flash-rose': {
          '0%': { backgroundColor: 'rgba(244,63,94,0.18)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: {
        'drawer-in': 'drawer-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'flash-rose': 'flash-rose 900ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;

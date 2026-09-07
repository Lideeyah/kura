import type { Config } from 'tailwindcss';

/**
 * KURA design tokens.
 *
 * The accent names are semantic on purpose. There is no `green` or `red` to reach for:
 * `approved` is the only green in the system and `veto` the only coral, so the colour
 * discipline is enforced by the type of the class name rather than by memory.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#09090b',
        surface: '#121214',
        'surface-2': '#18181b',
        border: '#27272a',
        'border-strong': '#3f3f46',
        'text-primary': '#f4f4f5',
        'text-muted': '#71717a',
        'text-dim': '#52525b',
        approved: '#5aa17f',
        veto: '#d9776a',
        warn: '#c69b4e',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      letterSpacing: { tight: '-0.02em' },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      maxWidth: { shell: '1240px' },
      keyframes: {
        'drawer-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'fade-up': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'drawer-in': 'drawer-in 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-up': 'fade-up 180ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;

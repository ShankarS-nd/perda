import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // ── Color System ──
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",

        // Background layers
        bg: {
          base: 'var(--bg-base)',
          secondary: 'var(--bg-secondary)',
          elevated: 'var(--bg-elevated)',
          surface: 'var(--bg-surface)',
        },

        // Primary brand
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          DEFAULT: '#6366f1',
        },

        // Semantic
        success: {
          DEFAULT: '#10b981',
          light: '#34d399',
          muted: 'rgba(16, 185, 129, 0.12)',
        },
        error: {
          DEFAULT: '#ef4444',
          light: '#f87171',
          muted: 'rgba(239, 68, 68, 0.12)',
        },
        warning: {
          DEFAULT: '#f59e0b',
          light: '#fbbf24',
          muted: 'rgba(245, 158, 11, 0.12)',
        },
        info: {
          DEFAULT: '#3b82f6',
          light: '#60a5fa',
          muted: 'rgba(59, 130, 246, 0.12)',
        },

        // Text
        txt: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          disabled: 'var(--text-disabled)',
        },

        // Borders
        edge: {
          DEFAULT: 'var(--border-default)',
          subtle: 'var(--border-subtle)',
          active: 'var(--border-active)',
        },
      },

      // Mid-tone elegant gray palette
      gray: {
        50:  '#f8fafc',
        100: '#f1f5f9',
        200: '#e2e8f0',
        300: '#cbd5e1',
        400: '#94a3b8',
        500: '#64748b',
        600: '#475569',
        700: '#334155',
        800: '#1e293b',
        900: '#0f172a',
        950: '#020617',
      },

      // ── Typography ──
      fontFamily: {
        sans: ['var(--font-geist-sans)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        'page-title': ['24px', { lineHeight: '1.2', fontWeight: '600', letterSpacing: '-0.02em' }],
        'section-title': ['18px', { lineHeight: '1.3', fontWeight: '600', letterSpacing: '-0.01em' }],
        'section-label': ['11px', { lineHeight: '1.4', fontWeight: '600', letterSpacing: '0.06em' }],
        'body': ['14px', { lineHeight: '1.6', fontWeight: '400' }],
        'body-sm': ['13px', { lineHeight: '1.5', fontWeight: '400' }],
        'label': ['12px', { lineHeight: '1.4', fontWeight: '500', letterSpacing: '0.02em' }],
        'caption': ['11px', { lineHeight: '1.4', fontWeight: '400', letterSpacing: '0.01em' }],
      },

      // ── Spacing (rem-based for responsive) ──
      spacing: {
        '4.5': '18px',
        '13': '52px',
        '15': '60px',
        '18': '72px',
        'sidebar': '260px',
        'sidebar-mini': '68px',
        'topbar': '56px',
      },

      // ── Border Radius ──
      borderRadius: {
        'sm': '6px',
        'md': '10px',
        'lg': '14px',
        'xl': '18px',
        '2xl': '24px',
      },

      // ── Elevation Shadows ──
      boxShadow: {
        'panel': '0 1px 2px rgba(0, 0, 0, 0.15)',
        'card': '0 2px 8px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.15)',
        'card-hover': '0 8px 24px rgba(0, 0, 0, 0.25), 0 2px 6px rgba(0, 0, 0, 0.15)',
        'floating': '0 16px 48px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.2)',
        'glass': '0 8px 32px rgba(0, 0, 0, 0.3)',
        'glow': '0 0 0 1px rgba(99, 102, 241, 0.2), 0 4px 16px rgba(99, 102, 241, 0.08)',
        'glow-strong': '0 0 0 2px rgba(99, 102, 241, 0.3), 0 8px 24px rgba(99, 102, 241, 0.15)',
        'btn-primary': '0 2px 8px rgba(99, 102, 241, 0.25), inset 0 1px 0 rgba(255,255,255,0.1)',
        'btn-primary-hover': '0 4px 16px rgba(99, 102, 241, 0.35), 0 0 24px rgba(99, 102, 241, 0.15)',
      },

      // ── Animation ──
      transitionDuration: {
        'instant': '100ms',
        'fast': '150ms',
        'normal': '250ms',
        'smooth': '350ms',
      },
      transitionTimingFunction: {
        'smooth': 'cubic-bezier(0.22, 1, 0.36, 1)',
        'bounce': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'snappy': 'cubic-bezier(0.2, 0, 0, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-scale': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'progress-indeterminate': {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
        'fade-in-up': 'fade-in-up 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
        'fade-in-scale': 'fade-in-scale 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-right': 'slide-in-right 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        'shimmer': 'shimmer 1.8s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'progress': 'progress-indeterminate 1.5s ease-in-out infinite',
      },

      // ── Layout ──
      maxWidth: {
        'content': '1440px',
      },
      width: {
        'sidebar': '260px',
        'sidebar-mini': '68px',
      },
      height: {
        'topbar': '56px',
      },
    },
  },
  plugins: [],
};
export default config;


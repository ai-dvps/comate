/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/client/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: 'hsl(var(--color-bg) / <alpha-value>)',
        surface: 'hsl(var(--color-surface) / <alpha-value>)',
        'surface-hover': 'hsl(var(--color-surface-hover) / <alpha-value>)',
        'surface-active': 'hsl(var(--color-surface-active) / <alpha-value>)',
        border: 'hsl(var(--color-border) / <alpha-value>)',
        'border-hover': 'hsl(var(--color-border-hover) / <alpha-value>)',
        accent: 'hsl(var(--color-accent) / <alpha-value>)',
        'accent-hover': 'hsl(var(--color-accent-hover) / <alpha-value>)',
        'accent-foreground': 'hsl(var(--color-accent-foreground) / <alpha-value>)',
        'text-primary': 'hsl(var(--color-text-primary) / <alpha-value>)',
        'text-secondary': 'hsl(var(--color-text-secondary) / <alpha-value>)',
        'text-tertiary': 'hsl(var(--color-text-tertiary) / <alpha-value>)',
        'msg-user': 'hsl(var(--color-msg-user) / <alpha-value>)',
        'msg-assistant': 'hsl(var(--color-msg-assistant) / <alpha-value>)',
        overlay: 'hsl(var(--color-overlay) / <alpha-value>)',
        destructive: 'hsl(var(--color-destructive) / <alpha-value>)',
        'destructive-foreground': 'hsl(var(--color-destructive-foreground) / <alpha-value>)',
        success: 'hsl(var(--color-success) / <alpha-value>)',
        warning: 'hsl(var(--color-warning) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}

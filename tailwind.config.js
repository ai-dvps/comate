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
        bg: '#0d0d0d',
        surface: '#141414',
        'surface-hover': '#1a1a1a',
        'surface-active': '#1f1f1f',
        border: '#262626',
        'border-hover': '#333333',
        accent: '#e57035',
        'accent-hover': '#f08045',
        'text-primary': '#f5f5f5',
        'text-secondary': '#a3a3a3',
        'text-tertiary': '#737373',
        'msg-user': '#1a1a1a',
        'msg-assistant': '#0d0d0d',
      },
    },
  },
  plugins: [],
}

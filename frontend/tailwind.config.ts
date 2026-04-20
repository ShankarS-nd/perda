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
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      // Mid-tone elegant gray palette — between dark and light
      gray: {
        50:  '#f3f4f6',
        100: '#e5e7ec',
        200: '#cdd2da',
        300: '#b0b7c5',
        400: '#949cad',
        500: '#727b8c',
        600: '#5c6578',
        700: '#4c5466',
        800: '#3e4656',
        900: '#343b4a',
        950: '#2b3140',
      },
    },
  },
  plugins: [],
};
export default config;

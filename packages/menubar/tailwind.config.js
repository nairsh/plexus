/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgba(28, 28, 30, 0.92)',
          elevated: 'rgba(44, 44, 46, 0.92)',
          card: 'rgba(58, 58, 60, 0.80)',
        },
        accent: {
          DEFAULT: '#0A84FF',
          green: '#30D158',
          red: '#FF453A',
          yellow: '#FFD60A',
          orange: '#FF9F0A',
        },
      },
      borderRadius: {
        DEFAULT: '10px',
        lg: '14px',
        xl: '18px',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

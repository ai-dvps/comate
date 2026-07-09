export const defaultLang = 'zh' as const;

export const ui = {
  zh: {
    'nav.home': '首页',
    'nav.features': '功能特性',
    'nav.usage': '使用方法',
    'nav.download': '下载',
    'nav.about': '关于',
    'footer.repo': 'GitHub 仓库',
    'footer.license': 'Apache 2.0 许可证',
    'languagePicker.label': '切换语言',
    '404.title': '页面未找到',
    '404.message': '抱歉，您访问的页面不存在。',
    '404.backHome': '返回首页',
  },
  en: {
    'nav.home': 'Home',
    'nav.features': 'Features',
    'nav.usage': 'Usage',
    'nav.download': 'Download',
    'nav.about': 'About',
    'footer.repo': 'GitHub Repository',
    'footer.license': 'Apache 2.0 License',
    'languagePicker.label': 'Switch language',
    '404.title': 'Page not found',
    '404.message': 'Sorry, the page you are looking for does not exist.',
    '404.backHome': 'Back to home',
  },
} as const;

export type Lang = keyof typeof ui;
export type UIKey = keyof typeof ui[typeof defaultLang];

export interface FormatOption {
  id: string;
  name: string;
  description: string;
  mimeType: string;
}

export const FORMAT_OPTIONS: FormatOption[] = [
  { id: 'markdown', name: 'Markdown', description: '标准 Markdown 格式', mimeType: 'text/markdown' },
  { id: 'html', name: 'HTML', description: '标准 HTML', mimeType: 'text/html' },
  { id: 'wechat', name: '微信公众号', description: '内联 CSS 样式', mimeType: 'text/html' },
  { id: 'zhihu', name: '知乎', description: '知乎兼容格式', mimeType: 'text/html' },
  { id: 'qidian', name: '起点/网文', description: '纯文本格式', mimeType: 'text/plain' },
];

export interface FormatConvertResponse {
  content: string;
  format: string;
  mime_type: string;
}

export interface FormatPreviewResponse {
  html: string;
}

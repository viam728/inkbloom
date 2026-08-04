import React from 'react';

interface PlatformLink {
  name: string;
  url: string;
  description: string;
}

const PLATFORM_LINKS: PlatformLink[] = [
  { name: '微信公众号', url: 'https://mp.weixin.qq.com/', description: '公众号后台' },
  { name: '知乎创作者中心', url: 'https://zhuanlan.zhihu.com/write', description: '知乎写作' },
  { name: '今日头条', url: 'https://mp.toutiao.com/profile_v4/graphic/publish', description: '头条号发布' },
  { name: '起点作家中心', url: 'https://author.qidian.com/', description: '起点中文网' },
];

const PlatformLinks: React.FC = () => {
  return (
    <div className="flex items-center gap-1">
      {PLATFORM_LINKS.map((link) => (
        <a
          key={link.name}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="px-2 py-1 rounded text-xs text-neutral-400 hover:text-indigo-400 hover:bg-neutral-700 transition-colors"
          title={`${link.name} - ${link.description}`}
        >
          {link.name}
        </a>
      ))}
    </div>
  );
};

export default PlatformLinks;

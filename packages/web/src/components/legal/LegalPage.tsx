import React from 'react';
import { Flower2 } from 'lucide-react';

/**
 * 法务文档静态页（技术方案 v2 §9.2）。
 *
 * 占位内容：正式文案由运营/法务提供后替换 LEGAL_DOCS 中的条目。
 * 路由由前端 SPA 承载（/legal/:slug），落地页页脚与注册页协议勾选均链接至此。
 */

interface LegalDoc {
  title: string;
  updatedAt: string;
  sections: { heading: string; body: string }[];
}

const LEGAL_DOCS: Record<string, LegalDoc> = {
  terms: {
    title: '用户协议',
    updatedAt: '2026-08-20',
    sections: [
      {
        heading: '一、服务说明',
        body: 'InkBloom 是面向创作者的 AI 辅助创作工具。桌面端提供离线创作能力；AI 生成、云同步等能力需联网并登录云端账号。本协议为用户与 InkBloom 运营主体之间的服务约定。',
      },
      {
        heading: '二、账号与实名',
        body: '用户以手机号注册即完成实名认证。账号仅限本人使用，禁止转让、出借。用户应妥善保管登录凭证，因用户主动泄露导致的损失由用户自行承担。',
      },
      {
        heading: '三、付费条款',
        body: '订阅服务与 Token 包为预付费虚拟权益。未消耗的 Token 余额依法可申请退款；已消耗部分不予退还。价格调整将提前 7 天在应用内公示。',
      },
      {
        heading: '四、生成式 AI 专项条款',
        body: '依据《生成式人工智能服务管理暂行办法》：AI 生成内容将进行标识；用户不得利用本服务生成违法、侵权内容；输入内容的合法性与权利归属由用户负责；未成年人应在监护人指导下使用。',
      },
      {
        heading: '五、内容权利',
        body: '用户保有创作内容的全部著作权。平台仅在提供存储、处理、同步服务所必需的范围内获得授权。',
      },
    ],
  },
  privacy: {
    title: '隐私政策',
    updatedAt: '2026-08-20',
    sections: [
      {
        heading: '一、信息收集',
        body: '我们收集：手机号（注册/登录/找回凭证）、创作内容（编辑器文本、大纲、记忆、素材文件）、设备信息与日志（排障与安全）。每项信息均对应明确的服务目的。',
      },
      {
        heading: '二、存储与位置',
        body: '云端数据存储于境内服务器。桌面端离线数据仅存于用户本机（%APPDATA%/InkBloom），不上传。',
      },
      {
        heading: '三、第三方共享',
        body: '为提供 AI 生成能力，用户主动发起的 AI 请求内容将传输至模型服务商（DeepSeek）。支付、短信、内容安全等基础服务由对应渠道处理必要信息。',
      },
      {
        heading: '四、用户权利',
        body: '用户可随时导出全部数据（.inkbloom 备份包）、更正个人信息、注销账号。注销经 15 天冷静期后物理删除，法定留存项除外。',
      },
      {
        heading: '五、本地存储说明',
        body: '前端使用 localStorage 保存登录态与降级缓存（后端不可达时的最后一道兜底），不用于任何追踪目的。',
      },
    ],
  },
};

const LegalPage: React.FC<{ slug: keyof typeof LEGAL_DOCS | string }> = ({ slug }) => {
  const doc = LEGAL_DOCS[slug as string] ?? {
    title: '文档不存在',
    updatedAt: '',
    sections: [{ heading: '', body: '请从落地页页脚或注册页进入有效文档。' }],
  };

  return (
    <div className="min-h-screen bg-surface-0 text-neutral-200">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="flex items-center gap-2.5 mb-8">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Flower2 size={18} className="text-white" />
          </div>
          <span className="text-sm tracking-[0.3em] text-neutral-400">INKBLOOM</span>
        </div>

        <h1 className="text-2xl font-semibold text-neutral-100">{doc.title}</h1>
        {doc.updatedAt && (
          <p className="mt-1.5 text-xs text-neutral-500">更新日期：{doc.updatedAt}</p>
        )}

        <div className="mt-8 space-y-7">
          {doc.sections.map((s, i) => (
            <section key={i}>
              {s.heading && (
                <h2 className="text-sm font-semibold text-neutral-200 mb-2">{s.heading}</h2>
              )}
              <p className="text-[13px] leading-relaxed text-neutral-400">{s.body}</p>
            </section>
          ))}
        </div>

        <p className="mt-12 pt-6 border-t border-white/8 text-[11px] text-neutral-600">
          本文档为上线前占位版本，正式文案以运营发布为准。
        </p>
      </div>
    </div>
  );
};

export default LegalPage;

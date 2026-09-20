import type { ValueLevel } from "../types.ts";

export type Category = {
  id: string;
  label: string;
  keywords: string[];
  intent: string;
  deliverableType: string;
  titleObject: string;
  valueLevel: ValueLevel;
  deprecated: boolean;
};

export const TAXONOMY: readonly Category[] = [
  {
    id: "software-development",
    label: "软件开发",
    keywords: ["代码", "开发", "调试", "测试", "bug", "api", "typescript", "javascript", "node", "python"],
    intent: "build_or_debug",
    deliverableType: "code",
    titleObject: "技术问题",
    valueLevel: "V2",
    deprecated: false,
  },
  {
    id: "product-planning",
    label: "产品规划",
    keywords: ["需求", "产品", "方案", "计划", "项目", "roadmap", "mvp", "规格", "验收"],
    intent: "plan",
    deliverableType: "plan",
    titleObject: "产品方案",
    valueLevel: "V2",
    deprecated: false,
  },
  {
    id: "writing",
    label: "内容写作",
    keywords: ["写作", "文案", "文章", "邮件", "总结", "润色", "翻译", "email", "draft"],
    intent: "create_content",
    deliverableType: "document",
    titleObject: "内容稿件",
    valueLevel: "V1",
    deprecated: false,
  },
  {
    id: "learning-research",
    label: "学习研究",
    keywords: ["学习", "研究", "论文", "课程", "解释", "分析", "调研", "research", "learn"],
    intent: "learn_or_research",
    deliverableType: "notes",
    titleObject: "研究主题",
    valueLevel: "V2",
    deprecated: false,
  },
  {
    id: "personal-life",
    label: "个人生活",
    keywords: ["旅行", "饮食", "健身", "生活", "家庭", "购物", "菜谱", "travel", "recipe"],
    intent: "personal_assistance",
    deliverableType: "advice",
    titleObject: "生活事项",
    valueLevel: "V1",
    deprecated: false,
  },
  {
    id: "other",
    label: "其他主题",
    keywords: [],
    intent: "unknown",
    deliverableType: "unknown",
    titleObject: "待确认事项",
    valueLevel: "V0",
    deprecated: false,
  },
] as const;

for (const category of TAXONOMY) {
  Object.freeze(category.keywords);
  Object.freeze(category);
}
Object.freeze(TAXONOMY);

const ACTIVE_TAXONOMY_IDS = new Set(
  TAXONOMY.filter((category) => !category.deprecated).map((category) => category.id),
);

export function isActiveTaxonomyId(id: string): boolean {
  return ACTIVE_TAXONOMY_IDS.has(id);
}

export function categoryById(id: string): Category | undefined {
  return TAXONOMY.find((category) => category.id === id);
}

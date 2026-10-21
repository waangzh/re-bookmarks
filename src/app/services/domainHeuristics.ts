/**
 * 常见高频域名与路径特征的功能印象映射表（仅占数 KB，零网络开销）。
 * 用于存量书签尚未跑过 AI 整理时的冷启动兜底。
 */
const DOMAIN_IMPRESSION_MAP: Record<string, string[]> = {
  "bilibili.com": ["视频网站", "弹幕视频", "B站", "在线追番", "中长视频", "学习视频"],
  "youtube.com": ["视频网站", "油管", "在线视频", "影音娱乐"],
  "netflix.com": ["视频网站", "奈飞", "美剧", "在线看剧", "流媒体"],
  "cupfox.app": ["视频网站", "茶杯狐", "影视搜索", "在线看剧", "电影网站"],
  "iqiyi.com": ["视频网站", "爱奇艺", "在线看剧", "综艺影视"],
  "v.qq.com": ["视频网站", "腾讯视频", "在线看剧", "影视"],
  "youku.com": ["视频网站", "优酷视频", "在线影视"],
  "douyin.com": ["视频网站", "短视频", "抖音", "直播"],
  "github.com": ["代码托管", "开源项目", "Git仓库", "开发工具", "源码"],
  "gitee.com": ["代码托管", "开源项目", "国内Git平台", "源码"],
  "stackoverflow.com": ["技术问答", "编程问题", "开发社区"],
  "huggingface.co": ["AI模型", "开源模型库", "机器学习", "大模型下载"],
  "openai.com": ["AI模型", "大模型", "人工智能"],
  "squoosh.app": ["图片压缩", "图像优化", "格式转换", "在线图片工具"],
  "tinypng.com": ["图片压缩", "PNG压缩", "图像体积优化"],
  "ray.so": ["代码截图", "代码美化图片", "分享代码片段"],
  "excalidraw.com": ["手绘白板", "在线画图", "流程图", "架构图工具"],
  "processon.com": ["思维导图", "流程图", "在线作图"],
  "figma.com": ["UI设计", "原型设计", "在线协作设计"],
  "notion.so": ["笔记", "知识库", "文档协作", "项目管理"],
  "linux.do": ["技术社区", "AI论坛", "开源交流社区"],
  "v2ex.com": ["程序员社区", "技术论坛", "创意工作者社区"],
  "zhihu.com": ["知识问答", "中文社区", "经验分享"],
  "juejin.cn": ["技术社区", "前端开发", "编程文章"],
  "developer.mozilla.org": ["前端文档", "Web开发手册", "API参考"],
  "stackexchange.com": ["技术问答", "知识社区"],
};

const VIDEO_HOST_PATTERN = /(video|movie|film|tv|cinema|vod|anime)/i;
const DOC_HOST_PATTERN = /(doc|docs|wiki|manual|guide)/i;
const TOOL_HOST_PATTERN = /(tool|tools|convert|compress|generator)/i;
const DOC_PATH_PATTERN = /\/(docs|wiki|guide)\b/i;

/** 根据 URL 提取静态兜底印象词，无法识别时返回空数组 */
export function getStaticImpressionKeywords(urlStr: string): string[] {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    for (const [domain, tags] of Object.entries(DOMAIN_IMPRESSION_MAP)) {
      if (host === domain || host.endsWith(`.${domain}`)) return tags;
    }

    const heuristicTags: string[] = [];
    if (VIDEO_HOST_PATTERN.test(host)) {
      heuristicTags.push("视频网站", "在线影视");
    }
    if (DOC_HOST_PATTERN.test(host) || DOC_PATH_PATTERN.test(url.pathname)) {
      heuristicTags.push("文档手册", "参考文档", "知识库");
    }
    if (TOOL_HOST_PATTERN.test(host)) {
      heuristicTags.push("在线工具", "效率工具");
    }
    return heuristicTags;
  } catch {
    return [];
  }
}

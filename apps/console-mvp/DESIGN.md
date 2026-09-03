---
version: alpha
name: BaiRui Console MVP
description: 紧凑、清晰的单用户云 Agent 控制台，基于 platform-overview(优化版).html 的信息密度与浅色业务界面语言。
colors:
  primary: "{colors.tc-primary}"
  tc-primary: "#0052D9"
  tc-primary-hover: "#0033B0"
  tc-primary-light: "#E8F3FF"
  tc-primary-50: "#F0F7FF"
  tc-accent: "#305EF8"
  tc-accent-2: "#722ED1"
  tc-bg: "#F5F7FA"
  tc-bg-2: "#F2F3F5"
  tc-surface: "#FFFFFF"
  tc-border: "#E5E6EB"
  tc-border-2: "#C9CDD4"
  tc-text: "#1F2329"
  tc-text-2: "#4E5969"
  tc-text-3: "#86909C"
  tc-text-4: "#C9CDD4"
  tc-success: "#006D1B"
  tc-success-light: "#E8FFEA"
  tc-warning: "#8A4B00"
  tc-warning-light: "#FFF7E8"
  tc-danger: "#B42318"
  tc-danger-light: "#FFECE8"
  tc-info: "#006D68"
  tc-info-light: "#E8FFFB"
typography:
  page-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, Segoe UI, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: 0em
  panel-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, Segoe UI, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0em
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, Segoe UI, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: 0em
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, Segoe UI, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0em
rounded:
  tc-sm: 4px
  tc: 6px
  tc-lg: 8px
  tc-xl: 12px
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 20px
  6: 24px
  7: 28px
  8: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.tc-surface}"
    rounded: "{rounded.tc}"
    height: 32px
  button-primary-hover:
    backgroundColor: "{colors.tc-primary-hover}"
  navigation-active:
    backgroundColor: "{colors.tc-primary-light}"
    textColor: "{colors.tc-primary}"
  focus-ring:
    backgroundColor: "{colors.tc-primary-50}"
  chart-series-primary:
    backgroundColor: "{colors.tc-accent}"
  chart-series-secondary:
    backgroundColor: "{colors.tc-accent-2}"
  canvas:
    backgroundColor: "{colors.tc-bg}"
  canvas-muted:
    backgroundColor: "{colors.tc-bg-2}"
  panel:
    backgroundColor: "{colors.tc-surface}"
    textColor: "{colors.tc-text}"
    rounded: "{rounded.tc-lg}"
    padding: "{spacing.5}"
  border-default:
    backgroundColor: "{colors.tc-border}"
  border-strong:
    backgroundColor: "{colors.tc-border-2}"
  text-secondary:
    textColor: "{colors.tc-text-2}"
  text-muted:
    textColor: "{colors.tc-text-3}"
  text-disabled:
    textColor: "{colors.tc-text-4}"
  status-success:
    backgroundColor: "{colors.tc-success-light}"
    textColor: "{colors.tc-success}"
  status-warning:
    backgroundColor: "{colors.tc-warning-light}"
    textColor: "{colors.tc-warning}"
  status-danger:
    backgroundColor: "{colors.tc-danger-light}"
    textColor: "{colors.tc-danger}"
  status-info:
    backgroundColor: "{colors.tc-info-light}"
    textColor: "{colors.tc-info}"
---

# BaiRui Agent Cloud MVP

## Overview

这是单用户云 Agent 控制台的前端 MVP。只使用本地 fixture，不接账号、鉴权、密钥、部署或运行后端。唯一视觉参考为 `docs/platform-overview(优化版).html`：沿用浅色画布、细边框、6px 卡片圆角和高信息密度，不复制其内容。

## Colors

以白色表面、浅灰画布和蓝色单一主操作构成稳定层级。绿色、橙色、红色仅表达成功、提醒和错误；状态必须同时包含文本或图标，不能只靠颜色。

## Typography

使用系统中文字体栈。页面标题为 24px，面板标题为 16px，正文为 14px，辅助标签为 12px；不使用夸张展示字体、紧缩字距或营销式超大标题。数值采用 tabular figures，保证卡片切换时不跳动。

## Layout

顶栏固定 56px，桌面侧栏 220px，主内容默认内边距 28px。使用 4px 基础间距，主要层级为 8/12/16/20/24/28/32px。KPI 四列、趋势区与辅助面板两列；在 1180px、900px、600px 逐级收缩，禁止横向溢出。

## Elevation & Depth

面板以边框和画布色差分层。普通卡片不使用阴影；只在 hover、顶部栏和弹窗使用轻阴影。禁止玻璃、渐变大背景、装饰光球与无业务意义的动效。

## Shapes

输入、按钮、KPI 和列表卡片统一使用 4px、6px、8px、12px 四档圆角。圆角服务于信息分组，不能形成胶囊化堆叠。

## Components

- 所有 UI 图标统一来自 `lucide-react`，图标按钮必须提供 `title` 和 `aria-label`。
- 总览使用“时间范围分段控件 + 四项 KPI + 趋势与活动面板 + 快捷操作”的固定层级。
- 模型连接是 Agent 级配置入口；API Key 为密码字段，不写入 React state、URL 或 `localStorage`。纯前端只能显示“等待后端验证”，不可模拟已连接。
- 图表必须有时间范围、图例和屏幕阅读器摘要；无数据、加载、失败、过期应显示明确状态。

## Do's and Don'ts

- 使用设计 token，避免在页面组件中新增硬编码颜色和任意圆角。
- 保持参考页的轻量边框、紧凑间距和克制 hover，不使用宣传页 Hero、瀑布流 Bento 或 GSAP 滚动叙事。
- 每页只强调一个主操作；次级操作使用描边或文本按钮。
- 验证桌面、平板和移动视口，确保文字换行、焦点状态、键盘操作和触摸目标可用。
